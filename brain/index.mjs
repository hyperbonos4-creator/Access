// VisionYX Brain — indexador. Recorre tus proyectos, trocea, censura secretos,
// genera embeddings (bge-m3) y guarda un índice vectorial local en data/index.json.
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig, embed, redactSecrets, walkFiles, chunkByLines, projectOf,
} from './lib.mjs';
import * as usage from './usage.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(cfg._dataDir, { recursive: true });

  console.log('VisionYX Brain · indexando proyectos\n');
  const records = [];
  let fileCount = 0;

  for (const root of cfg.roots) {
    if (!fs.existsSync(root)) { console.log(`  (omitido, no existe) ${root}`); continue; }
    const project = projectOf(root);
    const files = walkFiles(root, cfg);
    console.log(`• ${project}: ${files.length} archivos`);
    for (const file of files) {
      if (records.length >= cfg.maxChunksTotal) break;
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (raw.includes('\u0000')) continue; // binario
      const rel = project + '/' + path.relative(root, file).replace(/\\/g, '/');
      const chunks = chunkByLines(raw, cfg.chunkLines, cfg.chunkOverlap, cfg.maxChunksPerFile);
      for (const c of chunks) {
        if (records.length >= cfg.maxChunksTotal) break;
        records.push({
          id: records.length,
          project,
          file: rel,
          startLine: c.startLine,
          endLine: c.endLine,
          text: redactSecrets(c.text),
        });
      }
      fileCount++;
    }
    if (records.length >= cfg.maxChunksTotal) { console.log('  (tope de fragmentos alcanzado)'); break; }
  }

  console.log(`\nTotal: ${fileCount} archivos → ${records.length} fragmentos. Generando embeddings…`);

  // bge-m3 limita ~60k tokens POR PETICIÓN (suma de todos los textos del lote).
  // Empaquetamos por presupuesto de caracteres (~3.5 char/token en código) para
  // no pasarnos, con un tope de textos por lote.
  const MAX_TEXT = 1500;       // por fragmento
  const MAX_BATCH_CHARS = 70000; // ~20k tokens, holgado bajo el límite
  const MAX_BATCH_ITEMS = cfg.embedBatch;

  const texts = records.map((r) => `${r.file}\n${r.text}`.slice(0, MAX_TEXT));
  let done = 0;
  let i = 0;
  while (i < records.length) {
    // Arma el lote respetando ambos topes.
    let j = i, chars = 0;
    while (j < records.length && (j - i) < MAX_BATCH_ITEMS && chars + texts[j].length <= MAX_BATCH_CHARS) {
      chars += texts[j].length; j++;
    }
    if (j === i) j = i + 1; // un texto enorme: mándalo solo
    const slice = records.slice(i, j);
    const payload = texts.slice(i, j);
    let vecs;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { vecs = await embed(cfg, payload); break; }
      catch (e) {
        if (attempt === 4) throw e;
        const wait = 800 * attempt;
        console.log(`\n   reintentando lote @${i} (${e.message.slice(0, 80)}) en ${wait}ms`);
        await sleep(wait);
      }
    }
    slice.forEach((r, k) => { r.vector = vecs[k]; });
    usage.record({ embedCalls: 1, embedItems: slice.length });
    done += slice.length;
    process.stdout.write(`\r   embeddings: ${done}/${records.length}`);
    await sleep(120);
    i = j;
  }

  const dim = records[0]?.vector?.length || 0;
  const payload = {
    model: cfg.cloudflare.embedModel,
    chatModel: cfg.cloudflare.chatModel,
    dim,
    createdAt: new Date().toISOString(),
    count: records.length,
    chunks: records,
  };
  fs.writeFileSync(cfg._indexFile, JSON.stringify(payload));
  const mb = (fs.statSync(cfg._indexFile).size / 1e6).toFixed(1);
  console.log(`\n\n✔ Índice listo: ${records.length} fragmentos (dim ${dim}) · ${mb} MB`);
  console.log(`  Guardado en data/index.json. Ahora ejecuta:  npm start`);
}

main().catch((e) => { console.error('\nError:', e.message); process.exit(1); });
