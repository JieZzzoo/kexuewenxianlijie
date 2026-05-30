import { workflow, node, trigger, ifElse, splitInBatches, nextBatch, expr, newCredential } from '@n8n/workflow-sdk';

const start = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start', position: [0, 300] },
  output: [{}],
});

const readPdfs = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1.1,
  config: { name: 'Read PDFs', parameters: { operation: 'read', fileSelector: '/data/papers/*.pdf' }, position: [200, 300] },
  output: [{}],
});

const buildBatchReq = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Build MinerU Batch Request', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const items = $input.all();\nconst files = items.map(function(it, i){\n  const fn = (it.binary && it.binary.data && it.binary.data.fileName) ? it.binary.data.fileName : (\"paper-\" + (i+1) + \".pdf\");\n  return { name: fn, is_ocr: false, data_id: (\"paper-\" + i) };\n});\nreturn [{ json: { requestBody: { enable_formula: true, enable_table: true, language: \"en\", model_version: \"vlm\", files: files } } }];" }, position: [400, 300] },
  output: [{ requestBody: { enable_formula: true, enable_table: true, language: 'en', model_version: 'vlm', files: [{ name: '1706.03762.pdf', is_ocr: false, data_id: 'paper-0' }] } }],
});

const mineruSubmit = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'MinerU Submit Batch',
    parameters: {
      method: 'POST',
      url: 'https://mineru.net/api/v4/file-urls/batch',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [ { name: 'Authorization', value: expr('Bearer {{ $env.MINERU_TOKEN }}') }, { name: 'Content-Type', value: 'application/json' } ] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.requestBody) }}'),
    },
    position: [600, 300],
  },
  output: [{ code: 0, msg: 'ok', data: { batch_id: 'batch-123', file_urls: ['https://oss/u0', 'https://oss/u1', 'https://oss/u2'] } }],
});

const pairUploads = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Pair PDFs With Upload URLs', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const resp = $(\"MinerU Submit Batch\").first().json;\nconst urls = (resp.data && resp.data.file_urls) || [];\nconst batchId = resp.data && resp.data.batch_id;\nconst pdfs = $(\"Read PDFs\").all();\nreturn pdfs.map(function(it, i){\n  const bin = it.binary || {};\n  const fn = (bin.data && bin.data.fileName) ? bin.data.fileName : (\"paper-\" + (i+1) + \".pdf\");\n  const newBin = {};\n  if (bin.data) { newBin.data = Object.assign({}, bin.data, { mimeType: \"\", fileName: fn }); }\n  return { json: { uploadUrl: urls[i], batchId: batchId, name: fn }, binary: newBin };\n});" }, position: [800, 300] },
  output: [{ uploadUrl: 'https://oss/u0', batchId: 'batch-123', name: '1706.03762.pdf' }],
});

const uploadToMineru = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: { name: 'Upload PDF To MinerU', parameters: { method: 'PUT', url: expr('{{ $json.uploadUrl }}'), sendBody: true, contentType: 'binaryData', inputDataFieldName: 'data' }, position: [1000, 300] },
  output: [{}],
});

const getResults = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Get MinerU Results',
    executeOnce: true,
    parameters: {
      method: 'GET',
      url: expr('https://mineru.net/api/v4/extract-results/batch/{{ $("Pair PDFs With Upload URLs").first().json.batchId }}'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [ { name: 'Authorization', value: expr('Bearer {{ $env.MINERU_TOKEN }}') } ] },
    },
    position: [1200, 300],
  },
  output: [{ code: 0, msg: 'ok', data: { batch_id: 'batch-123', extract_result: [{ file_name: '1706.03762.pdf', state: 'done', full_zip_url: 'https://cdn/x.zip', err_msg: '' }] } }],
});

const allDone = ifElse({
  version: 2.3,
  config: {
    name: 'All Papers Parsed?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.data.extract_result.length > 0 && $json.data.extract_result.every(r => ["done","failed"].includes(r.state)) }}'), operator: { type: 'boolean', operation: 'true', singleValue: true }, rightValue: '' }],
      },
    },
    position: [1400, 300],
  },
});

const waitPoll = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait Before Re-poll', parameters: { resume: 'timeInterval', amount: 8, unit: 'seconds' }, position: [1400, 480] },
  output: [{}],
});

const splitPapers = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split Papers', parameters: { fieldToSplitOut: 'data.extract_result', include: 'noOtherFields' }, position: [1600, 200] },
  output: [{ file_name: '1706.03762.pdf', state: 'done', full_zip_url: 'https://cdn/x.zip', err_msg: '' }],
});

const loopPapers = splitInBatches({ version: 3, config: { name: 'Loop Over Papers', parameters: { batchSize: 1 }, position: [1800, 200] } });

const downloadZip = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: { name: 'Download Result Zip', parameters: { method: 'GET', url: expr('{{ $json.full_zip_url }}'), options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } } }, position: [2000, 100] },
  output: [{}],
});

const decompress = node({
  type: 'n8n-nodes-base.compression',
  version: 1.1,
  config: { name: 'Decompress Zip', parameters: { operation: 'decompress', binaryPropertyName: 'data', outputPrefix: 'mu_' }, position: [2200, 100] },
  output: [{}],
});

const parseZip = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Parse MinerU Output', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const items = $input.all();\nconst out = [];\nfor (let i = 0; i < items.length; i++) {\n  const bin = items[i].binary || {};\n  let fullText = \"\";\n  let contentList = [];\n  const imagesByName = {};\n  for (const key of Object.keys(bin)) {\n    const meta = bin[key];\n    const name = (meta.fileName || \"\");\n    const lower = name.toLowerCase();\n    let buf;\n    try { buf = await this.helpers.getBinaryDataBuffer(i, key); }\n    catch (e) { buf = Buffer.from(meta.data || \"\", \"base64\"); }\n    if (lower.endsWith(\"content_list.json\")) {\n      try { contentList = JSON.parse(buf.toString(\"utf8\")); } catch (e) {}\n    } else if (lower.endsWith(\".md\")) {\n      const t = buf.toString(\"utf8\");\n      if (t.length > fullText.length) fullText = t;\n    } else if (lower.endsWith(\".jpg\") || lower.endsWith(\".jpeg\") || lower.endsWith(\".png\") || lower.endsWith(\".gif\") || lower.endsWith(\".webp\")) {\n      const ext = lower.split(\".\").pop();\n      const mime = ext === \"png\" ? \"image/png\" : (ext === \"webp\" ? \"image/webp\" : (ext === \"gif\" ? \"image/gif\" : \"image/jpeg\"));\n      const uri = \"data:\" + mime + \";base64,\" + buf.toString(\"base64\");\n      imagesByName[name] = uri;\n      imagesByName[name.split(\"/\").pop()] = uri;\n    }\n  }\n  const figures = []; const tables = []; let fi = 0; let ti = 0;\n  for (const el of contentList) {\n    if (el.type === \"image\") {\n      fi++;\n      const p = el.img_path || el.image_path || \"\";\n      const base = p.split(\"/\").pop();\n      const dataUri = imagesByName[p] || imagesByName[base] || \"\";\n      const cap = Array.isArray(el.image_caption) ? el.image_caption.join(\" \") : (el.image_caption || el.img_caption || \"\");\n      figures.push({ id: (\"fig-\" + fi), caption: cap, dataUri: dataUri });\n    } else if (el.type === \"table\") {\n      ti++;\n      const cap = Array.isArray(el.table_caption) ? el.table_caption.join(\" \") : (el.table_caption || \"\");\n      const body = el.table_body || el.table_html || el.text || \"\";\n      const p2 = el.img_path || \"\"; const base2 = p2.split(\"/\").pop();\n      const dataUri = p2 ? (imagesByName[p2] || imagesByName[base2] || \"\") : \"\";\n      tables.push({ id: (\"tbl-\" + ti), caption: cap, markdown: body, dataUri: dataUri });\n    }\n  }\n  let fileName = \"paper-\" + (i + 1) + \".pdf\";\n  try { fileName = $(\"Loop Over Papers\").first().json.file_name || fileName; } catch (e) {}\n  const baseName = fileName.split(\".\").slice(0, -1).join(\".\") || fileName;\n  out.push({ json: { fileName: fileName, baseName: baseName, fullText: fullText, figures: figures, tables: tables } });\n}\nreturn out;" }, position: [2400, 100] },
  output: [{ fileName: '1706.03762.pdf', baseName: '1706.03762', fullText: '# Attention Is All You Need', figures: [{ id: 'fig-1', caption: 'Figure 1', dataUri: 'data:image/png;base64,AAAA' }], tables: [{ id: 'tbl-1', caption: 'Table 1', markdown: '| a | b |', dataUri: '' }] }],
});

const analyzePaper = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Analyze Paper (DeepSeek + Qwen-VL)', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const NL = String.fromCharCode(10);\nconst items = $input.all();\nconst out = [];\nfor (let idx = 0; idx < items.length; idx++) {\n  const j = items[idx].json;\n  const allFigs = j.figures || [];\n  const figs = allFigs.filter(function(f){ return f.dataUri; });\n  const tbls = j.tables || [];\n  const dsKey = $env.DEEPSEEK_API_KEY;\n  const qwKey = $env.DASHSCOPE_API_KEY;\n  const ctx = (j.fullText || \"\").slice(0, 1500);\n\n  const tblBlocks = tbls.map(function(t){ return t.id + \" 表标题: \" + (t.caption || \"(无)\") + NL + \"表格HTML: \" + (t.markdown || \"(无)\"); }).join(NL + NL);\n  const schemaExample = JSON.stringify({ body: { scientificQuestion: \"\", hypothesis: \"\", novelty: \"\", experimentalSetup: \"\", conclusions: \"\" }, tables: [{ id: \"tbl-1\", analysis: \"\" }] });\n  const dsInstruction = [\"论文全文(Markdown)：\", (j.fullText || \"\").slice(0, 120000), \"\", \"本论文的表（结合表标题、表格HTML与正文，分析关键数据与结论）：\", tblBlocks || \"(无表)\", \"\", \"请严格只输出如下结构 JSON（不要解释或代码块标记）：\", schemaExample, \"全部用中文。tables 为每个表 id 各一项，id 与上面一致。\"].join(NL);\n  const dsBody = { model: \"deepseek-v4-pro\", messages: [{ role: \"system\", content: \"你是严谨的科学论文审稿人，只输出一个 JSON 对象。\" }, { role: \"user\", content: dsInstruction }], response_format: { type: \"json_object\" }, temperature: 0.2, max_tokens: 12000 };\n  const dsPromise = this.helpers.httpRequest({ method: \"POST\", url: \"https://api.deepseek.com/chat/completions\", headers: { Authorization: \"Bearer \" + dsKey, \"Content-Type\": \"application/json\" }, body: dsBody, json: true }).then(function(r){ try { return JSON.parse(r.choices[0].message.content); } catch (e) { return { body: {}, tables: [] }; } }).catch(function(e){ return { body: {}, tables: [], _dsErr: String((e && e.message) || e).slice(0, 120) }; });\n\n  const figPrompt = function(f){ return \"这是论文中的一张图。论文背景节选：\" + ctx + NL + \"图标题：\" + (f.caption || \"(无标题)\") + NL + \"请用中文详细解读这张图：展示了什么内容、关键结构或数据、在论文中的科学意义。直接输出分析，不要客套。\"; };\n  const qwCall = (f) => this.helpers.httpRequest({ method: \"POST\", url: \"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions\", headers: { Authorization: \"Bearer \" + qwKey, \"Content-Type\": \"application/json\" }, body: { model: \"qwen3-vl-plus\", messages: [{ role: \"user\", content: [{ type: \"image_url\", image_url: { url: f.dataUri } }, { type: \"text\", text: figPrompt(f) }] }], max_tokens: 1200 }, json: true }).then(function(r){ return { id: f.id, analysis: r.choices[0].message.content }; }).catch(function(e){ return { id: f.id, analysis: \"(图分析失败：\" + String((e && e.message) || e).slice(0, 100) + \")\" }; });\n\n  const figureAnalyses = [];\n  for (let i = 0; i < figs.length; i += 5) {\n    const part = await Promise.all(figs.slice(i, i + 5).map(qwCall));\n    for (let k = 0; k < part.length; k++) figureAnalyses.push(part[k]);\n  }\n  const dsResult = await dsPromise;\n  out.push({ json: { fileName: j.fileName, baseName: j.baseName, body: dsResult.body || {}, tableAnalyses: dsResult.tables || [], figureAnalyses: figureAnalyses, figures: allFigs, tables: tbls } });\n}\nreturn out;" }, position: [2600, 100] },
  output: [{ fileName: '1706.03762.pdf', baseName: '1706.03762', body: { scientificQuestion: '' }, tableAnalyses: [{ id: 'tbl-1', analysis: '' }], figureAnalyses: [{ id: 'fig-1', analysis: '' }], figures: [{ id: 'fig-1', caption: 'Figure 1', dataUri: 'data:image/png;base64,AAAA' }], tables: [{ id: 'tbl-1', caption: 'Table 1', markdown: '| a | b |', dataUri: '' }] }],
});

const assemblePaperMd = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Assemble Paper Markdown', parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: "const NL = String.fromCharCode(10);\nconst j = $json;\nconst fileName = j.fileName; const baseName = j.baseName;\nconst figs = j.figures || []; const tbls = j.tables || [];\nconst body = j.body || {};\nconst figAna = {}; (j.figureAnalyses || []).forEach(function(f){ figAna[f.id] = f.analysis; });\nconst tblAna = {}; (j.tableAnalyses || []).forEach(function(t){ tblAna[t.id] = t.analysis; });\nconst L = [];\nL.push(\"# \" + fileName); L.push(\"\");\nL.push(\"## 正文分析\"); L.push(\"\");\nL.push(\"**科学问题：** \" + (body.scientificQuestion || \"\")); L.push(\"\");\nL.push(\"**科学假设：** \" + (body.hypothesis || \"\")); L.push(\"\");\nL.push(\"**创新点：** \" + (body.novelty || \"\")); L.push(\"\");\nL.push(\"**实验设置：** \" + (body.experimentalSetup || \"\")); L.push(\"\");\nL.push(\"**结论：** \" + (body.conclusions || \"\")); L.push(\"\");\nL.push(\"## 图分析\"); L.push(\"\");\nfigs.forEach(function(f){\n  L.push(\"### \" + f.id + (f.caption ? (\" — \" + f.caption) : \"\"));\n  if (f.dataUri) { L.push('<img src=\"' + f.dataUri + '\" style=\"max-width:100%\" />'); }\n  L.push(\"\"); L.push(figAna[f.id] || \"(无分析)\"); L.push(\"\");\n});\nL.push(\"## 表分析\"); L.push(\"\");\ntbls.forEach(function(t){\n  L.push(\"### \" + t.id + (t.caption ? (\" — \" + t.caption) : \"\"));\n  if (t.dataUri) { L.push('<img src=\"' + t.dataUri + '\" style=\"max-width:100%\" />'); }\n  else if (t.markdown) { L.push(\"\"); L.push(t.markdown); }\n  L.push(\"\"); L.push(tblAna[t.id] || \"(无分析)\"); L.push(\"\");\n});\nreturn { json: { fileName: fileName, baseName: baseName, paperMarkdown: L.join(NL) } };" }, position: [2800, 100] },
  output: [{ fileName: '1706.03762.pdf', baseName: '1706.03762', paperMarkdown: '# 1706.03762.pdf' }],
});

const paperMdToFile = node({
  type: 'n8n-nodes-base.convertToFile',
  version: 1.1,
  config: { name: 'Paper MD To File', parameters: { operation: 'toText', sourceProperty: 'paperMarkdown', binaryPropertyName: 'data', options: { dataIsBase64: false, encoding: 'utf8', fileName: expr('{{ $json.baseName }}.md'), mimeType: 'text/markdown' } }, position: [3000, 100] },
  output: [{ baseName: '1706.03762' }],
});

const writePaperMd = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1.1,
  config: { name: 'Write Paper MD', parameters: { operation: 'write', fileName: expr('/data/out/{{ $("Assemble Paper Markdown").item.json.baseName }}.md'), dataPropertyName: 'data' }, position: [3200, 100] },
  output: [{}],
});

const readPaperMds = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1.1,
  config: { name: 'Read All Paper MDs', parameters: { operation: 'read', fileSelector: '/data/out/*.md' }, position: [2000, 400] },
  output: [{}],
});

const combineReport = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Combine Report', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const NL = String.fromCharCode(10);\nconst items = $input.all();\nconst parts = [];\nfor (let i = 0; i < items.length; i++) {\n  const bin = items[i].binary || {};\n  const key = Object.keys(bin)[0];\n  let txt = \"\";\n  if (key) {\n    try { txt = (await this.helpers.getBinaryDataBuffer(i, key)).toString(\"utf8\"); }\n    catch (e) { txt = Buffer.from(bin[key].data || \"\", \"base64\").toString(\"utf8\"); }\n  }\n  const name = (bin[key] && bin[key].fileName) || (\"paper-\" + i);\n  parts.push({ name: name, txt: txt });\n}\nparts.sort(function(a, b){ return a.name.localeCompare(b.name); });\nconst sep = NL + NL + \"---\" + NL + NL;\nconst header = \"# 文献精读报告\" + NL + NL + \"生成时间：\" + $now.toISO() + NL + NL + \"共 \" + parts.length + \" 篇文献\" + sep;\nconst reportMarkdown = header + parts.map(function(p){ return p.txt; }).join(sep);\n\nfunction esc(s){ return s.split(\"&\").join(\"&amp;\").split(\"<\").join(\"&lt;\").split(\">\").join(\"&gt;\"); }\nfunction boldify(s){ const a = s.split(\"**\"); let r = \"\"; for (let i = 0; i < a.length; i++){ r += (i % 2 === 1) ? (\"<strong>\" + a[i] + \"</strong>\") : a[i]; } return r; }\nconst lines = reportMarkdown.split(NL);\nconst htmlParts = []; let inList = false;\nfunction closeList(){ if (inList) { htmlParts.push(\"</ul>\"); inList = false; } }\nfor (let i = 0; i < lines.length; i++) {\n  const ln = lines[i];\n  const t = ln.trim();\n  if (t.length === 0) { closeList(); continue; }\n  if (ln.charAt(0) === \"<\") { closeList(); htmlParts.push(ln); continue; }\n  if (t === \"---\") { closeList(); htmlParts.push(\"<hr>\"); continue; }\n  if (ln.indexOf(\"### \") === 0) { closeList(); htmlParts.push(\"<h3>\" + boldify(esc(ln.slice(4))) + \"</h3>\"); continue; }\n  if (ln.indexOf(\"## \") === 0) { closeList(); htmlParts.push(\"<h2>\" + boldify(esc(ln.slice(3))) + \"</h2>\"); continue; }\n  if (ln.indexOf(\"# \") === 0) { closeList(); htmlParts.push(\"<h1>\" + boldify(esc(ln.slice(2))) + \"</h1>\"); continue; }\n  if (ln.indexOf(\"- \") === 0 || ln.indexOf(\"* \") === 0) { if (!inList) { htmlParts.push(\"<ul>\"); inList = true; } htmlParts.push(\"<li>\" + boldify(esc(ln.slice(2))) + \"</li>\"); continue; }\n  closeList(); htmlParts.push(\"<p>\" + boldify(esc(ln)) + \"</p>\");\n}\ncloseList();\nconst style = \"<style>body{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.7;color:#222}img{max-width:100%;height:auto;display:block;margin:10px 0}h1{font-size:24px}h2{font-size:20px;border-bottom:1px solid #eee;padding-bottom:4px}h3{font-size:16px;color:#0a58ca}hr{border:none;border-top:1px solid #ddd;margin:28px 0}</style>\";\nconst htmlReport = '<!doctype html><html><head><meta charset=\"utf-8\">' + style + '</head><body>' + htmlParts.join(NL) + '</body></html>';\nreturn [{ json: { reportMarkdown: reportMarkdown, htmlReport: htmlReport, paperCount: parts.length } }];" }, position: [2200, 400] },
  output: [{ reportMarkdown: '# 文献精读报告', htmlReport: '<!doctype html><html><body></body></html>', paperCount: 3 }],
});

const htmlToFile = node({
  type: 'n8n-nodes-base.convertToFile',
  version: 1.1,
  config: { name: 'Report HTML To File', parameters: { operation: 'toText', sourceProperty: 'htmlReport', binaryPropertyName: 'data', options: { dataIsBase64: false, encoding: 'utf8', fileName: '文献精读报告.html', mimeType: 'text/html' } }, position: [2600, 400] },
  output: [{}],
});

const sendEmail = node({
  type: 'n8n-nodes-base.emailSend',
  version: 2.1,
  config: {
    name: 'Send To QQ Mail',
    parameters: {
      operation: 'send',
      fromEmail: expr('{{ $env.QQ_SMTP_USER }}'),
      toEmail: expr('{{ $env.QQ_MAIL_TO || $env.QQ_SMTP_USER }}'),
      subject: expr('文献精读报告 {{ $now.toFormat("yyyy-MM-dd") }}'),
      emailFormat: 'html',
      html: expr('{{ $("Combine Report").item.json.htmlReport }}'),
      options: { attachments: 'data', appendAttribution: false },
    },
    credentials: { smtp: newCredential('QQ SMTP') },
    position: [2800, 400],
  },
  output: [{}],
});

export default workflow('lit-review-report', '科学文献精读报告')
  .add(start)
  .to(readPdfs)
  .to(buildBatchReq)
  .to(mineruSubmit)
  .to(pairUploads)
  .to(uploadToMineru)
  .to(getResults)
  .to(allDone
    .onTrue(splitPapers
      .to(loopPapers
        .onEachBatch(downloadZip
          .to(decompress)
          .to(parseZip)
          .to(analyzePaper)
          .to(assemblePaperMd)
          .to(paperMdToFile)
          .to(writePaperMd)
          .to(nextBatch(loopPapers)))
        .onDone(readPaperMds
          .to(combineReport)
          .to(htmlToFile)
          .to(sendEmail))))
    .onFalse(waitPoll.to(getResults)));
