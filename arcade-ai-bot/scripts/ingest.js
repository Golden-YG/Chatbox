import 'dotenv/config';
import axios from 'axios';
import cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

function parseArgs() {
	const args = Object.fromEntries(process.argv.slice(2).map(kv => {
		const [k, v] = kv.split('=');
		return [k.replace(/^--/, ''), v ?? true];
	}));
	return {
		site: args.site || 'https://www.arcade.ai',
		limit: Number(args.limit || 40),
		timeoutMs: Number(args.timeoutMs || 15000),
		headers: { 'User-Agent': 'ArcadeBotIngest/0.1 (+https://www.arcade.ai/)' },
	};
}

function sameHost(url, site) {
	try {
		const a = new URL(url);
		const b = new URL(site);
		return a.host === b.host && a.protocol === b.protocol;
	} catch {
		return false;
	}
}

async function fetchSitemapUrls(site, timeoutMs, headers) {
	try {
		const smUrl = new URL('/sitemap.xml', site).toString();
		const { data } = await axios.get(smUrl, { timeout: timeoutMs, headers });
		const xml = await parseStringPromise(data);
		const urls = (xml.urlset?.url || [])
			.map(u => (u.loc?.[0] || '').trim())
			.filter(Boolean);
		return urls;
	} catch {
		return [];
	}
}

async function fetchHomepageUrls(site, timeoutMs, headers) {
	try {
		const { data } = await axios.get(site, { timeout: timeoutMs, headers });
		const $ = cheerio.load(data);
		const urls = new Set();
		$('a[href]').each((_i, el) => {
			const href = $(el).attr('href');
			if (!href) return;
			try {
				const abs = new URL(href, site).toString();
				if (sameHost(abs, site)) urls.add(abs);
			} catch {}
		});
		return Array.from(urls);
	} catch {
		return [];
	}
}

function extractTitleAndText(html) {
	const $ = cheerio.load(html);
	const title = ($('title').first().text() || '').trim();
	$('script,noscript,style').remove();
	const text = $('body').text().replace(/\s+/g, ' ').trim();
	return { title, text };
}

function chunkText(text, chunkSize = 1200, overlap = 150) {
	const chunks = [];
	let start = 0;
	while (start < text.length) {
		const end = Math.min(text.length, start + chunkSize);
		const chunk = text.slice(start, end);
		if (chunk.trim().length > 0) chunks.push(chunk.trim());
		start = end - overlap;
		if (start < 0) start = 0;
		if (start >= text.length) break;
	}
	return chunks;
}

async function embedBatch(texts) {
	const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
	return res.data.map(d => d.embedding);
}

async function main() {
	const { site, limit, timeoutMs, headers } = parseArgs();
	if (!process.env.OPENAI_API_KEY) {
		console.error('Missing OPENAI_API_KEY');
		process.exit(1);
	}
	const outDir = path.join(__dirname, '..', 'data');
	await fs.ensureDir(outDir);

	let urls = await fetchSitemapUrls(site, timeoutMs, headers);
	if (urls.length === 0) {
		urls = await fetchHomepageUrls(site, timeoutMs, headers);
	}
	urls = urls.filter(u => sameHost(u, site));
	urls = urls.slice(0, limit);

	console.log(`Discovered ${urls.length} URLs to ingest from ${site}`);

	const vectors = [];
	for (const url of urls) {
		try {
			const { data } = await axios.get(url, { timeout: timeoutMs, headers });
			const { title, text } = extractTitleAndText(data);
			if (!text || text.length < 200) continue;
			const chunks = chunkText(text);
			const embeddings = await embedBatch(chunks);
			for (let i = 0; i < chunks.length; i++) {
				vectors.push({
					id: `${url}#${i}`,
					url,
					title,
					content: chunks[i],
					embedding: embeddings[i],
				});
			}
			console.log(`Ingested ${url} (${chunks.length} chunks)`);
		} catch (err) {
			console.warn(`Failed to ingest ${url}:`, err?.message || err);
		}
	}

	const index = {
		site,
		generatedAt: new Date().toISOString(),
		model: EMBEDDING_MODEL,
		vectors,
	};
	const outPath = path.join(outDir, 'index.json');
	await fs.writeFile(outPath, JSON.stringify(index));
	console.log(`Saved index with ${vectors.length} chunks to ${outPath}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});