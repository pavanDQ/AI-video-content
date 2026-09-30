/** AI Medical Video POC — API server (Node 18, ESM). */

import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { libraryRouter } from './routes/library.js';
import { studioRouter } from './routes/studio.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
// Source content and storyboards are text-heavy, so allow a generous body.
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_request, response) => response.json({ ok: true, node: process.version }));
app.use('/api/studio', studioRouter);
app.use('/api/library', libraryRouter);

app.use((_request, response) => response.status(404).json({ error: 'Not found.' }));

app.use((error, _request, response, _next) => {
  const status = error.statusCode || 500;
  if (status >= 500) console.error('[server]', error);
  response.status(status).json({ error: error.message || 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`AI Medical Video POC API listening on http://localhost:${port}`);
});
