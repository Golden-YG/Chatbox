import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import pino from 'pino';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const port = Number(process.env.PORT || 8787);

app.use(bodyParser.json({ limit: '2mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const DEFAULT_COMPLETION_MODEL = process.env.COMPLETION_MODEL || 'gpt-4o-mini';

let vectorIndex = null; // { vectors: [ { id, url, title, content, embedding:number[] } ], model }

async function loadIndex() {
	try {
		const idxPath = path.join(__dirname, '..', 'data', 'index.json');
		if (await fs.pathExists(idxPath)) {
			const raw = await fs.readFile(idxPath, 'utf8');
			vectorIndex = JSON.parse(raw);
			logger.info({ vectors: vectorIndex.vectors?.length || 0, model: vectorIndex.model }, 'RAG index loaded');
		} else {
			logger.warn('No data/index.json found. Run `npm run ingest` to build a knowledge index.');
		}
	} catch (err) {
		logger.error({ err }, 'Failed to load index');
	}
}

function cosineSimilarity(a, b) {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

async function embedText(text) {
	const res = await openai.embeddings.create({ model: DEFAULT_EMBEDDING_MODEL, input: text });
	return res.data[0].embedding;
}

function selectTopK(questionEmbedding, k = 6) {
	if (!vectorIndex || !Array.isArray(vectorIndex.vectors) || vectorIndex.vectors.length === 0) {
		return [];
	}
	const scored = vectorIndex.vectors.map(v => ({ ...v, score: cosineSimilarity(questionEmbedding, v.embedding) }));
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, k);
}

function buildSystemPrompt() {
	return [
		'You are the Arcade (https://www.arcade.ai/) AI customer support agent.',
		'- Be concise, accurate, and helpful. Use a friendly, professional tone.',
		'- Prefer information from the provided CONTEXT. If the answer is not in CONTEXT, say you will connect them to a human agent rather than guessing.',
		'- When appropriate, include 1-3 helpful links from CONTEXT.',
		'- Never invent product capabilities or pricing.',
	].join('\n');
}

function buildUserPrompt(question, contexts) {
	const contextBlock = contexts.map((c, i) => `# Source ${i + 1}\nTitle: ${c.title || ''}\nURL: ${c.url}\n-----\n${c.content}`)
		.join('\n\n');
	return `CONTEXT:\n${contextBlock}\n\nUSER QUESTION:\n${question}`;
}

async function answerQuestion(question) {
	const qEmbedding = await embedText(question);
	const contexts = selectTopK(qEmbedding, 6);
	const system = buildSystemPrompt();
	const user = buildUserPrompt(question, contexts);

	const chat = await openai.chat.completions.create({
		model: DEFAULT_COMPLETION_MODEL,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user },
		],
		temperature: 0.2,
		max_tokens: 400,
	});

	const text = chat.choices?.[0]?.message?.content?.trim() || "I'm not sure yet; let me connect you with a human teammate.";
	const sources = contexts.slice(0, 3).map(c => ({ title: c.title || '', url: c.url }));
	return { reply: text, sources };
}

app.get('/health', (_req, res) => {
	res.json({ ok: true });
});

app.post('/bot/answer', async (req, res) => {
	try {
		const question = (req.body?.question || '').toString().trim();
		if (!process.env.OPENAI_API_KEY) {
			return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
		}
		if (!question) {
			return res.status(400).json({ error: 'Missing `question`' });
		}
		const { reply, sources } = await answerQuestion(question);
		res.json({ reply, sources });
	} catch (err) {
		logger.error({ err }, 'Error answering');
		res.status(500).json({ error: 'Internal error' });
	}
});

app.get('/test', async (req, res) => {
	try {
		const q = (req.query.q || '').toString().trim();
		if (!q) return res.status(400).json({ error: 'Missing q' });
		const { reply, sources } = await answerQuestion(q);
		res.json({ reply, sources });
	} catch (err) {
		logger.error({ err }, 'Test failed');
		res.status(500).json({ error: 'Internal error' });
	}
});

app.post('/admin/reload', async (_req, res) => {
	await loadIndex();
	res.json({ ok: true, vectors: vectorIndex?.vectors?.length || 0 });
});

await loadIndex();

app.listen(port, () => {
	logger.info(`AI bot server listening on http://localhost:${port}`);
});