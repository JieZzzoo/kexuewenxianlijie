import { workflow, node, trigger, expr, ifElse, splitInBatches, nextBatch, newCredential } from '@n8n/workflow-sdk';

const formTrig = trigger({ type: 'n8n-nodes-base.formTrigger', version: 2.5, config: { name: '输入问题', parameters: {
  formTitle: '科学文献检索',
  formDescription: '输入一个科研问题，系统自动检索并下载开放获取的全文 PDF，供后续精读。',
  formFields: { values: [
    { fieldLabel: 'research_question', fieldType: 'textarea', placeholder: '例：AI 如何辅助靶向治疗蛋白质结构设计与功能优化？', requiredField: true },
    { fieldLabel: 'domain', fieldType: 'text', placeholder: 'protein design, protein language model, diffusion model' },
    { fieldLabel: 'max_papers', fieldType: 'number', placeholder: '8' },
    { fieldLabel: 'year_from', fieldType: 'number', placeholder: '2018' },
    { fieldLabel: 'year_to', fieldType: 'number', placeholder: '2026' }
  ] }
}, position: [180, 300] }, output: [{ research_question: '' }] });

const genQuery = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: '生成检索式(DeepSeek)', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "\n// Turn the user's question into an OpenAlex keyword query via DeepSeek (falls back to raw input).\nconst form = $input.first().json;\nconst question = form.research_question || form.question || '';\nconst domain = form.domain || '';\nconst maxPapers = parseInt(form.max_papers, 10) || 8;\nconst yearFrom = parseInt(form.year_from, 10) || 2018;\nconst yearTo = parseInt(form.year_to, 10) || 2026;\nconst key = $env.DEEPSEEK_API_KEY;\nlet query = '';\ntry {\n  const r = await this.helpers.httpRequest({ method:'POST', url:'https://api.deepseek.com/chat/completions', headers:{ Authorization:'Bearer '+key, 'Content-Type':'application/json' }, body:{ model:'deepseek-v4-pro', messages:[{ role:'system', content:'You convert a research question into a concise English keyword search query for an academic search engine (OpenAlex). Output ONLY a JSON object {\\\"query\\\":\\\"...\\\"} containing 3-8 space-separated key terms. No boolean operators, no quotes inside, no explanation.' },{ role:'user', content:'Research question: ' + question + '\\nDomain hints: ' + domain }], response_format:{ type:'json_object' }, temperature:0.2, max_tokens:3000 }, json:true });\n  const c = JSON.parse(r.choices[0].message.content);\n  query = String(c.query || '').trim();\n} catch (e) {}\nif (!query) query = String(domain || question).slice(0, 200);\nreturn [{ json: { query: query, question: question, domain: domain, max_papers: maxPapers, year_from: yearFrom, year_to: yearTo } }];\n" }, position: [360, 300] }, output: [{ query: '' }] });

const search = node({ type: 'n8n-nodes-base.httpRequest', version: 4.4, config: { name: 'Search OpenAlex', parameters: {
  method: 'GET', url: 'https://api.openalex.org/works', sendQuery: true, specifyQuery: 'keypair',
  queryParameters: { parameters: [
    { name: 'search', value: expr('{{ $json.query }}') },
    { name: 'per-page', value: expr('{{ $json.max_papers }}') },
    { name: 'filter', value: expr('open_access.is_oa:true,from_publication_date:{{ $json.year_from }}-01-01,to_publication_date:{{ $json.year_to }}-12-31') },
    { name: 'mailto', value: '1736672988@qq.com' }
  ] },
  options: { timeout: 30000 }
}, position: [540, 300] }, output: [{ results: [] }] });

const standardize = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Standardize + Candidates', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "\nconst resp = $input.first().json;\nconst works = (resp && resp.results) || [];\nfunction reconstructAbstract(inv){\n  if(!inv || typeof inv !== 'object') return '';\n  const w = [];\n  for(const k of Object.keys(inv)){ const pos = inv[k]; if(Array.isArray(pos)){ for(let i=0;i<pos.length;i++) w.push([pos[i], k]); } }\n  return w.sort(function(a,b){ return a[0]-b[0]; }).map(function(x){ return x[1]; }).join(' ');\n}\nfunction sanitize(s){ return String(s||'').replace(/[\\\\/:*?\"<>|\\n\\r\\t]+/g,'_').replace(/\\s+/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'').slice(0,120); }\nfunction norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }\nconst out = [];\nconst usedNames = {};\nconst seenPapers = {};\nfor(let i=0;i<works.length;i++){\n  const w = works[i];\n  const doi = (w.doi || '').replace('https://doi.org/','').toLowerCase();\n  const title = w.display_name || w.title || ('paper-'+(i+1));\n  const pkey = doi || norm(title);\n  if(pkey && seenPapers[pkey]) continue;\n  if(pkey) seenPapers[pkey] = 1;\n  const cands = [];\n  let arxivId = '';\n  const m = /arxiv\\.(\\d{4}\\.\\d{4,5})/i.exec(doi);\n  if(m) arxivId = m[1];\n  if(!arxivId){ const ax = (w.ids && w.ids.arxiv) || ''; const m2 = /(\\d{4}\\.\\d{4,5})/.exec(ax); if(m2) arxivId = m2[1]; }\n  if(arxivId) cands.push('https://arxiv.org/pdf/' + arxivId);\n  const best = w.best_oa_location || {};\n  if(best.pdf_url) cands.push(best.pdf_url);\n  (w.locations || []).forEach(function(l){ if(l && l.pdf_url) cands.push(l.pdf_url); });\n  const oa = w.open_access || {};\n  if(oa.oa_url) cands.push(oa.oa_url);\n  const uniq = []; const seen = {};\n  cands.forEach(function(u){ if(u && !seen[u]){ seen[u]=1; uniq.push(u); } });\n  const pmcid = (w.ids && w.ids.pmcid) ? String(w.ids.pmcid).split('/').pop() : '';\n  let base = sanitize(title) || ('paper-'+(i+1));\n  let fn = base + '.pdf'; let n = 2;\n  while(usedNames[fn]){ fn = base + '_' + n + '.pdf'; n++; }\n  usedNames[fn] = 1;\n  out.push({ json: {\n    pdfFileName: fn, title: title, doi: doi, pmcid: pmcid,\n    year: w.publication_year || '',\n    authors: (w.authorships || []).map(function(a){ return a.author && a.author.display_name; }).filter(Boolean).slice(0,8).join(', '),\n    abstract: reconstructAbstract(w.abstract_inverted_index),\n    candidateCount: uniq.length, candidates: uniq\n  }});\n}\nreturn out;\n" }, position: [720, 300] }, output: [{ pdfFileName: 'x.pdf' }] });

const enrich = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Enrich Candidates (Europe PMC)', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "\nconst self = this;\nconst items = $input.all();\nasync function pmcidForDoi(doi){\n  try{\n    const r = await self.helpers.httpRequest({ method:'GET', url:'https://www.ebi.ac.uk/europepmc/webservices/rest/search', qs:{ query:'DOI:'+doi, format:'json', resultType:'lite', pageSize:1 }, json:true, timeout:20000 });\n    const res = (r && r.resultList && r.resultList.result) || [];\n    if(res.length){ const x = res[0]; const isOA = (x.isOpenAccess === 'Y') || (x.inEPMC === 'Y') || (x.inPMC === 'Y'); if(x.pmcid && isOA) return x.pmcid; }\n  }catch(e){}\n  return '';\n}\nasync function enrich(j){\n  const cands = (j.candidates || []).slice();\n  let pmcid = j.pmcid || '';\n  if(!pmcid && j.doi) pmcid = await pmcidForDoi(j.doi);\n  if(pmcid){ cands.unshift('https://www.ncbi.nlm.nih.gov/pmc/articles/' + pmcid + '/pdf/'); cands.unshift('https://europepmc.org/articles/' + pmcid + '?pdf=render'); }\n  const uniq = []; const seen = {};\n  cands.forEach(function(u){ if(u && !seen[u]){ seen[u]=1; uniq.push(u); } });\n  return Object.assign({}, j, { pmcid: pmcid, candidates: uniq, candidateCount: uniq.length });\n}\nconst out = await Promise.all(items.map(function(it){ return enrich(it.json); }));\nreturn out.map(function(j){ return { json: j }; });\n" }, position: [900, 300] }, output: [{ pdfFileName: 'x.pdf' }] });

const prepReview = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: '准备人工复核清单', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "\nconst items = $input.all();\nconst candidates = items.map(function(it, i){ return Object.assign({ review_id: i+1 }, it.json); });\nfunction short(s, n){ const t = String(s||'').replace(/\\s+/g,' ').trim(); return t.length>n ? t.slice(0,n)+'...' : (t || '(\u65e0\u6458\u8981)'); }\nconst NL = String.fromCharCode(10);\nconst L = [];\nL.push('# \u4eba\u5de5\u590d\u6838 \u2014 \u5019\u9009\u6587\u732e\uff08\u786e\u8ba4\u7cbe\u9009\u6587\u732e\u5e93\uff09');\nL.push('');\nL.push('\u8bf7\u5728\u4e0b\u65b9\u8f93\u5165\u8981**\u4fdd\u7559**\u7684\u6587\u732e\u5e8f\u53f7\uff08\u9017\u53f7\u5206\u9694\uff0c\u5982 `1,3,5`\uff1b\u5168\u90e8\u4fdd\u7559\u8f93\u5165 `all`\uff09\u3002\u4ec5\u4fdd\u7559\u9879\u4f1a\u4e0b\u8f7d\u5168\u6587 PDF \u5e76\u8fdb\u5165\u7cbe\u8bfb\u3002');\nL.push('');\nL.push('\u6807 `\u26a0 \u65e0\u5168\u6587\u5019\u9009` \u7684\u591a\u534a\u4e0b\u4e0d\u5230 PDF\uff0c\u5efa\u8bae\u8df3\u8fc7\u3002');\nL.push('');\nfor(const p of candidates){\n  const tag = (p.candidateCount>0) ? ('\u5019\u9009PDF ' + p.candidateCount + ' \u4e2a') : '\u26a0 \u65e0\u5168\u6587\u5019\u9009';\n  L.push('## ' + p.review_id + '. ' + (p.title || '(\u65e0\u6807\u9898)'));\n  L.push('- \u5e74\u4efd\uff1a' + (p.year || '\u672a\u77e5') + ' \uff5c ' + tag + (p.pmcid ? (' \uff5c PMC:' + p.pmcid) : ''));\n  L.push('- \u4f5c\u8005\uff1a' + (p.authors || '\u672a\u77e5'));\n  L.push('- \u6458\u8981\uff1a' + short(p.abstract, 320));\n  L.push('');\n}\nreturn [{ json: { reviewMarkdown: L.join(NL), reviewCandidates: candidates, total: candidates.length } }];\n" }, position: [1080, 300] }, output: [{ reviewMarkdown: '' }] });

const waitReview = node({ type: 'n8n-nodes-base.wait', version: 1.1, config: { name: '等待人工复核', parameters: {
  resume: 'form', formTitle: '人工复核候选文献', formDescription: expr('{{ $json.reviewMarkdown }}'),
  formFields: { values: [
    { fieldLabel: 'human_keep_ids', fieldType: 'textarea', placeholder: '例：1,3,5 ；全部保留输入 all', requiredField: true },
    { fieldLabel: 'human_review_note', fieldType: 'textarea', placeholder: '可选：复核备注' }
  ] }
}, position: [1260, 300] }, output: [{ human_keep_ids: 'all' }] });

const applyReview = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: '应用人工复核结果', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "\nconst waitOut = $input.first().json;\nconst prep = $('\u51c6\u5907\u4eba\u5de5\u590d\u6838\u6e05\u5355').first().json;\nconst candidates = (prep && prep.reviewCandidates) || [];\nfunction getField(o, name){ return o[name] || (o.data && o.data[name]) || (o.formData && o.formData[name]) || (o.body && o.body[name]) || ''; }\nconst raw = String(getField(waitOut, 'human_keep_ids') || '').trim();\nlet keep;\nif(!raw || raw.toLowerCase()==='all' || raw==='\u5168\u90e8'){ keep = 'all'; }\nelse { const s = {}; raw.replace(/\uff0c/g, ',').split(',').forEach(function(x){ const n=parseInt(String(x).trim(),10); if(n>0) s[n]=1; }); keep = s; }\nlet sel = (keep==='all') ? candidates : candidates.filter(function(p){ return keep[Number(p.review_id)]; });\nsel = sel.filter(function(p){ return (p.candidates || []).length > 0; });\nreturn sel.map(function(p){ return { json: { pdfFileName: p.pdfFileName, title: p.title, doi: p.doi, candidates: p.candidates } }; });\n" }, position: [1440, 300] }, output: [{ pdfFileName: 'x.pdf' }] });

const dl = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Download & Validate PDF', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "\nconst UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';\nconst self = this;\nconst items = $input.all();\nasync function fetchPdf(cands) {\n  const tried = [];\n  for (let i = 0; i < cands.length; i++) {\n    const url = cands[i];\n    try {\n      const resp = await self.helpers.httpRequest({ method: 'GET', url: url, encoding: 'arraybuffer', timeout: 45000, headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*' } });\n      const buf = Buffer.from(resp);\n      if (buf.length > 1000 && buf.slice(0, 5).toString('latin1') === '%PDF-') return { buf: buf, url: url, tried: tried };\n      tried.push(url + ' -> not-pdf(' + buf.length + 'B)');\n    } catch (e) { tried.push(url + ' -> err:' + String((e && e.message) || e).slice(0, 70)); }\n  }\n  return { buf: null, url: null, tried: tried };\n}\nconst results = await Promise.all(items.map(function(it){ return fetchPdf((it.json && it.json.candidates) || []); }));\nconst out = [];\nfor (let k = 0; k < items.length; k++) {\n  const j = items[k].json;\n  const r = results[k];\n  if (r.buf) {\n    const bin = await self.helpers.prepareBinaryData(r.buf, j.pdfFileName, 'application/pdf');\n    out.push({ json: { pdfFileName: j.pdfFileName, title: j.title, ok: true, bytes: r.buf.length, sourceUrl: r.url, tried: r.tried }, binary: { data: bin } });\n  } else {\n    out.push({ json: { pdfFileName: j.pdfFileName, title: j.title, ok: false, bytes: 0, sourceUrl: null, tried: r.tried } });\n  }\n}\nreturn out.filter(function(o){ return o.json.ok; });\n" }, position: [1620, 300] }, output: [{ pdfFileName: 'x.pdf', ok: true }] });

const writePdf = node({ type: 'n8n-nodes-base.readWriteFile', version: 1.1, config: { name: 'Write PDF To papers', parameters: { operation: 'write', fileName: expr('/data/papers/{{ $json.pdfFileName }}'), dataPropertyName: 'data' }, position: [1800, 300] }, output: [{}] });

const manualStart = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: '手动精读(papers已就绪)', position: [180, 560] },
  output: [{}],
});

const readPdfs = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1.1,
  config: { name: 'Read PDFs', executeOnce: true, parameters: { operation: 'read', fileSelector: '/data/papers/*.pdf' }, position: [2300, 300] },
  output: [{}],
});

const buildBatchReq = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Build MinerU Batch Request', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const items = $input.all();\nconst files = items.map(function(it, i){\n  const fn = (it.binary && it.binary.data && it.binary.data.fileName) ? it.binary.data.fileName : (\"paper-\" + (i+1) + \".pdf\");\n  return { name: fn, is_ocr: false, data_id: (\"paper-\" + i) };\n});\nreturn [{ json: { requestBody: { enable_formula: true, enable_table: true, language: \"en\", model_version: \"vlm\", files: files } } }];" }, position: [2500, 300] },
  output: [{ requestBody: { enable_formula: true, enable_table: true, language: 'en', model_version: 'vlm', files: [{ name: '1706.03762.pdf', is_ocr: false, data_id: 'paper-0' }] } }],
});

const mineruSubmit = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'MinerU Submit Batch', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
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
    position: [2700, 300],
  },
  output: [{ code: 0, msg: 'ok', data: { batch_id: 'batch-123', file_urls: ['https://oss/u0', 'https://oss/u1', 'https://oss/u2'] } }],
});

const pairUploads = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Pair PDFs With Upload URLs', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const resp = $(\"MinerU Submit Batch\").first().json;\nconst urls = (resp.data && resp.data.file_urls) || [];\nconst batchId = resp.data && resp.data.batch_id;\nconst pdfs = $(\"Read PDFs\").all();\nreturn pdfs.map(function(it, i){\n  const bin = it.binary || {};\n  const fn = (bin.data && bin.data.fileName) ? bin.data.fileName : (\"paper-\" + (i+1) + \".pdf\");\n  const newBin = {};\n  if (bin.data) { newBin.data = Object.assign({}, bin.data, { mimeType: \"\", fileName: fn }); }\n  return { json: { uploadUrl: urls[i], batchId: batchId, name: fn }, binary: newBin };\n});" }, position: [2900, 300] },
  output: [{ uploadUrl: 'https://oss/u0', batchId: 'batch-123', name: '1706.03762.pdf' }],
});

const uploadToMineru = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: { name: 'Upload PDF To MinerU', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, parameters: { method: 'PUT', url: expr('{{ $json.uploadUrl }}'), sendBody: true, contentType: 'binaryData', inputDataFieldName: 'data' }, position: [3100, 300] },
  output: [{}],
});

const getResults = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Get MinerU Results', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    executeOnce: true,
    parameters: {
      method: 'GET',
      url: expr('https://mineru.net/api/v4/extract-results/batch/{{ $("Pair PDFs With Upload URLs").first().json.batchId }}'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [ { name: 'Authorization', value: expr('Bearer {{ $env.MINERU_TOKEN }}') } ] },
    },
    position: [3300, 300],
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
    position: [3500, 300],
  },
});

const waitPoll = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Wait Before Re-poll', parameters: { resume: 'timeInterval', amount: 8, unit: 'seconds' }, position: [3500, 480] },
  output: [{}],
});

const splitPapers = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split Papers', parameters: { fieldToSplitOut: 'data.extract_result', include: 'noOtherFields' }, position: [3700, 200] },
  output: [{ file_name: '1706.03762.pdf', state: 'done', full_zip_url: 'https://cdn/x.zip', err_msg: '' }],
});

const loopPapers = splitInBatches({ version: 3, config: { name: 'Loop Over Papers', parameters: { batchSize: 1 }, position: [3900, 200] } });

const downloadZip = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: { name: 'Download Result Zip', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, parameters: { method: 'GET', url: expr('{{ $json.full_zip_url }}'), options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } } }, position: [4100, 100] },
  output: [{}],
});

const decompress = node({
  type: 'n8n-nodes-base.compression',
  version: 1.1,
  config: { name: 'Decompress Zip', parameters: { operation: 'decompress', binaryPropertyName: 'data', outputPrefix: 'mu_' }, position: [4300, 100] },
  output: [{}],
});

const parseZip = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Parse MinerU Output', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const items = $input.all();\nconst out = [];\nfor (let i = 0; i < items.length; i++) {\n  const bin = items[i].binary || {};\n  let fullText = \"\";\n  let contentList = [];\n  const imagesByName = {};\n  for (const key of Object.keys(bin)) {\n    const meta = bin[key];\n    const name = (meta.fileName || \"\");\n    const lower = name.toLowerCase();\n    let buf;\n    try { buf = await this.helpers.getBinaryDataBuffer(i, key); }\n    catch (e) { buf = Buffer.from(meta.data || \"\", \"base64\"); }\n    if (lower.endsWith(\"content_list.json\")) {\n      try { contentList = JSON.parse(buf.toString(\"utf8\")); } catch (e) {}\n    } else if (lower.endsWith(\".md\")) {\n      const t = buf.toString(\"utf8\");\n      if (t.length > fullText.length) fullText = t;\n    } else if (lower.endsWith(\".jpg\") || lower.endsWith(\".jpeg\") || lower.endsWith(\".png\") || lower.endsWith(\".gif\") || lower.endsWith(\".webp\")) {\n      const ext = lower.split(\".\").pop();\n      const mime = ext === \"png\" ? \"image/png\" : (ext === \"webp\" ? \"image/webp\" : (ext === \"gif\" ? \"image/gif\" : \"image/jpeg\"));\n      const uri = \"data:\" + mime + \";base64,\" + buf.toString(\"base64\");\n      imagesByName[name] = uri;\n      imagesByName[name.split(\"/\").pop()] = uri;\n    }\n  }\n  const figures = []; const tables = []; let fi = 0; let ti = 0;\n  for (const el of contentList) {\n    if (el.type === \"image\") {\n      fi++;\n      const p = el.img_path || el.image_path || \"\";\n      const base = p.split(\"/\").pop();\n      const dataUri = imagesByName[p] || imagesByName[base] || \"\";\n      const cap = Array.isArray(el.image_caption) ? el.image_caption.join(\" \") : (el.image_caption || el.img_caption || \"\");\n      figures.push({ id: (\"fig-\" + fi), caption: cap, dataUri: dataUri });\n    } else if (el.type === \"table\") {\n      ti++;\n      const cap = Array.isArray(el.table_caption) ? el.table_caption.join(\" \") : (el.table_caption || \"\");\n      const body = el.table_body || el.table_html || el.text || \"\";\n      const p2 = el.img_path || \"\"; const base2 = p2.split(\"/\").pop();\n      const dataUri = p2 ? (imagesByName[p2] || imagesByName[base2] || \"\") : \"\";\n      tables.push({ id: (\"tbl-\" + ti), caption: cap, markdown: body, dataUri: dataUri });\n    }\n  }\n  let fileName = \"paper-\" + (i + 1) + \".pdf\";\n  try { fileName = $(\"Loop Over Papers\").first().json.file_name || fileName; } catch (e) {}\n  const baseName = fileName.split(\".\").slice(0, -1).join(\".\") || fileName;\n  out.push({ json: { fileName: fileName, baseName: baseName, fullText: fullText, figures: figures, tables: tables } });\n}\nreturn out;" }, position: [4500, 100] },
  output: [{ fileName: '1706.03762.pdf', baseName: '1706.03762', fullText: '# Attention Is All You Need', figures: [{ id: 'fig-1', caption: 'Figure 1', dataUri: 'data:image/png;base64,AAAA' }], tables: [{ id: 'tbl-1', caption: 'Table 1', markdown: '| a | b |', dataUri: '' }] }],
});

const analyzePaper = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Analyze Paper (DeepSeek + Qwen-VL)', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const NL = String.fromCharCode(10);\nconst items = $input.all();\nconst out = [];\nfor (let idx = 0; idx < items.length; idx++) {\n  const j = items[idx].json;\n  const allFigs = j.figures || [];\n  const figs = allFigs.filter(function(f){ return f.dataUri; });\n  const tbls = j.tables || [];\n  const dsKey = $env.DEEPSEEK_API_KEY;\n  const qwKey = $env.DASHSCOPE_API_KEY;\n  const ctx = (j.fullText || \"\").slice(0, 1500);\n\n  const tblBlocks = tbls.map(function(t){ return t.id + \" 表标题: \" + (t.caption || \"(无)\") + NL + \"表格HTML: \" + (t.markdown || \"(无)\"); }).join(NL + NL);\n  const schemaExample = JSON.stringify({ body: { scientificQuestion: \"\", hypothesis: \"\", novelty: \"\", experimentalSetup: \"\", conclusions: \"\" }, tables: [{ id: \"tbl-1\", analysis: \"\" }] });\n  const dsInstruction = [\"论文全文(Markdown)：\", (j.fullText || \"\").slice(0, 120000), \"\", \"本论文的表（结合表标题、表格HTML与正文，分析关键数据与结论）：\", tblBlocks || \"(无表)\", \"\", \"请严格只输出如下结构 JSON（不要解释或代码块标记）：\", schemaExample, \"全部用中文。tables 为每个表 id 各一项，id 与上面一致。\"].join(NL);\n  const dsBody = { model: \"deepseek-v4-pro\", messages: [{ role: \"system\", content: \"你是严谨的科学论文审稿人，只输出一个 JSON 对象。\" }, { role: \"user\", content: dsInstruction }], response_format: { type: \"json_object\" }, temperature: 0.2, max_tokens: 12000 };\n  const dsPromise = this.helpers.httpRequest({ method: \"POST\", url: \"https://api.deepseek.com/chat/completions\", headers: { Authorization: \"Bearer \" + dsKey, \"Content-Type\": \"application/json\" }, body: dsBody, json: true }).then(function(r){ try { return JSON.parse(r.choices[0].message.content); } catch (e) { return { body: {}, tables: [] }; } }).catch(function(e){ return { body: {}, tables: [], _dsErr: String((e && e.message) || e).slice(0, 120) }; });\n\n  const figPrompt = function(f){ return \"这是论文中的一张图。论文背景节选：\" + ctx + NL + \"图标题：\" + (f.caption || \"(无标题)\") + NL + \"请用中文详细解读这张图：展示了什么内容、关键结构或数据、在论文中的科学意义。直接输出分析，不要客套。\"; };\n  const qwCall = (f) => this.helpers.httpRequest({ method: \"POST\", url: \"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions\", headers: { Authorization: \"Bearer \" + qwKey, \"Content-Type\": \"application/json\" }, body: { model: \"qwen3-vl-plus\", messages: [{ role: \"user\", content: [{ type: \"image_url\", image_url: { url: f.dataUri } }, { type: \"text\", text: figPrompt(f) }] }], max_tokens: 1200 }, json: true }).then(function(r){ return { id: f.id, analysis: r.choices[0].message.content }; }).catch(function(e){ return { id: f.id, analysis: \"(图分析失败：\" + String((e && e.message) || e).slice(0, 100) + \")\" }; });\n\n  const figureAnalyses = [];\n  for (let i = 0; i < figs.length; i += 5) {\n    const part = await Promise.all(figs.slice(i, i + 5).map(qwCall));\n    for (let k = 0; k < part.length; k++) figureAnalyses.push(part[k]);\n  }\n  const dsResult = await dsPromise;\n  out.push({ json: { fileName: j.fileName, baseName: j.baseName, body: dsResult.body || {}, tableAnalyses: dsResult.tables || [], figureAnalyses: figureAnalyses, figures: allFigs, tables: tbls } });\n}\nreturn out;" }, position: [4700, 100] },
  output: [{ fileName: '1706.03762.pdf', baseName: '1706.03762', body: { scientificQuestion: '' }, tableAnalyses: [{ id: 'tbl-1', analysis: '' }], figureAnalyses: [{ id: 'fig-1', analysis: '' }], figures: [{ id: 'fig-1', caption: 'Figure 1', dataUri: 'data:image/png;base64,AAAA' }], tables: [{ id: 'tbl-1', caption: 'Table 1', markdown: '| a | b |', dataUri: '' }] }],
});

const assemblePaperMd = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Assemble Paper Markdown', parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: "const NL = String.fromCharCode(10);\nconst j = $json;\nconst fileName = j.fileName; const baseName = j.baseName;\nconst figs = j.figures || []; const tbls = j.tables || [];\nconst body = j.body || {};\nconst figAna = {}; (j.figureAnalyses || []).forEach(function(f){ figAna[f.id] = f.analysis; });\nconst tblAna = {}; (j.tableAnalyses || []).forEach(function(t){ tblAna[t.id] = t.analysis; });\nconst L = [];\nL.push(\"# \" + fileName); L.push(\"\");\nL.push(\"## 正文分析\"); L.push(\"\");\nL.push(\"**科学问题：** \" + (body.scientificQuestion || \"\")); L.push(\"\");\nL.push(\"**科学假设：** \" + (body.hypothesis || \"\")); L.push(\"\");\nL.push(\"**创新点：** \" + (body.novelty || \"\")); L.push(\"\");\nL.push(\"**实验设置：** \" + (body.experimentalSetup || \"\")); L.push(\"\");\nL.push(\"**结论：** \" + (body.conclusions || \"\")); L.push(\"\");\nL.push(\"## 图分析\"); L.push(\"\");\nfigs.forEach(function(f){\n  L.push(\"### \" + f.id + (f.caption ? (\" — \" + f.caption) : \"\"));\n  if (f.dataUri) { L.push('<img src=\"' + f.dataUri + '\" style=\"max-width:100%\" />'); }\n  L.push(\"\"); L.push(figAna[f.id] || \"(无分析)\"); L.push(\"\");\n});\nL.push(\"## 表分析\"); L.push(\"\");\ntbls.forEach(function(t){\n  L.push(\"### \" + t.id + (t.caption ? (\" — \" + t.caption) : \"\"));\n  if (t.dataUri) { L.push('<img src=\"' + t.dataUri + '\" style=\"max-width:100%\" />'); }\n  else if (t.markdown) { L.push(\"\"); L.push(t.markdown); }\n  L.push(\"\"); L.push(tblAna[t.id] || \"(无分析)\"); L.push(\"\");\n});\nreturn { json: { fileName: fileName, baseName: baseName, paperMarkdown: L.join(NL) } };" }, position: [4900, 100] },
  output: [{ fileName: '1706.03762.pdf', baseName: '1706.03762', paperMarkdown: '# 1706.03762.pdf' }],
});

const paperMdToFile = node({
  type: 'n8n-nodes-base.convertToFile',
  version: 1.1,
  config: { name: 'Paper MD To File', parameters: { operation: 'toText', sourceProperty: 'paperMarkdown', binaryPropertyName: 'data', options: { dataIsBase64: false, encoding: 'utf8', fileName: expr('{{ $json.baseName }}.md'), mimeType: 'text/markdown' } }, position: [5100, 100] },
  output: [{ baseName: '1706.03762' }],
});

const writePaperMd = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1.1,
  config: { name: 'Write Paper MD', parameters: { operation: 'write', fileName: expr('/data/out/{{ $("Assemble Paper Markdown").item.json.baseName }}.md'), dataPropertyName: 'data' }, position: [5300, 100] },
  output: [{}],
});

const readPaperMds = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1.1,
  config: { name: 'Read All Paper MDs', parameters: { operation: 'read', fileSelector: '/data/out/*.md' }, position: [4100, 400] },
  output: [{}],
});

const combineReport = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Combine Report', parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const NL = String.fromCharCode(10);\nconst self = this;\nconst items = $input.all();\nconst parts = [];\nfor (let i = 0; i < items.length; i++) {\n  const bin = items[i].binary || {};\n  const key = Object.keys(bin)[0];\n  let txt = \"\";\n  if (key) {\n    try { txt = (await self.helpers.getBinaryDataBuffer(i, key)).toString(\"utf8\"); }\n    catch (e) { txt = Buffer.from(bin[key].data || \"\", \"base64\").toString(\"utf8\"); }\n  }\n  const name = (bin[key] && bin[key].fileName) || (\"paper-\" + i);\n  parts.push({ name: name, txt: txt });\n}\nparts.sort(function(a, b){ return a.name.localeCompare(b.name); });\nfunction esc(s){ return s.split(\"&\").join(\"&amp;\").split(\"<\").join(\"&lt;\").split(\">\").join(\"&gt;\"); }\nfunction boldify(s){ const a = s.split(\"**\"); let r = \"\"; for (let i = 0; i < a.length; i++){ r += (i % 2 === 1) ? (\"<strong>\" + a[i] + \"</strong>\") : a[i]; } return r; }\nfunction mdToBody(md){\n  const lines = md.split(NL);\n  const o = []; let inList = false;\n  function closeList(){ if (inList) { o.push(\"</ul>\"); inList = false; } }\n  for (let i = 0; i < lines.length; i++) {\n    const ln = lines[i]; const t = ln.trim();\n    if (t.length === 0) { closeList(); continue; }\n    if (ln.charAt(0) === \"<\") { closeList(); o.push(ln); continue; }\n    if (t === \"---\") { closeList(); o.push(\"<hr>\"); continue; }\n    if (ln.indexOf(\"### \") === 0) { closeList(); o.push(\"<h3>\" + boldify(esc(ln.slice(4))) + \"</h3>\"); continue; }\n    if (ln.indexOf(\"## \") === 0) { closeList(); o.push(\"<h2>\" + boldify(esc(ln.slice(3))) + \"</h2>\"); continue; }\n    if (ln.indexOf(\"# \") === 0) { closeList(); o.push(\"<h1>\" + boldify(esc(ln.slice(2))) + \"</h1>\"); continue; }\n    if (ln.indexOf(\"- \") === 0 || ln.indexOf(\"* \") === 0) { if (!inList) { o.push(\"<ul>\"); inList = true; } o.push(\"<li>\" + boldify(esc(ln.slice(2))) + \"</li>\"); continue; }\n    closeList(); o.push(\"<p>\" + boldify(esc(ln)) + \"</p>\");\n  }\n  closeList();\n  return o.join(NL);\n}\nconst style = \"<style>body{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.7;color:#222}img{max-width:100%;height:auto;display:block;margin:10px 0}h1{font-size:24px}h2{font-size:20px;border-bottom:1px solid #eee;padding-bottom:4px}h3{font-size:16px;color:#0a58ca}hr{border:none;border-top:1px solid #ddd;margin:28px 0}</style>\";\nconst headerHtml = \"<h1>\u6587\u732e\u7cbe\u8bfb\u62a5\u544a</h1><p>\u751f\u6210\u65f6\u95f4\uff1a\" + $now.toISO() + \"</p><p>\u5171 \" + parts.length + \" \u7bc7\u6587\u732e</p><hr>\";\nconst frags = [];\nfor (let i = 0; i < parts.length; i++) { frags.push(mdToBody(parts[i].txt)); }\nconst htmlReport = '<!doctype html><html><head><meta charset=\"utf-8\">' + style + '</head><body>' + headerHtml + frags.join(NL + \"<hr>\" + NL) + '</body></html>';\nconst bin = await self.helpers.prepareBinaryData(Buffer.from(htmlReport, \"utf8\"), \"\u6587\u732e\u7cbe\u8bfb\u62a5\u544a.html\", \"text/html\");\nreturn [{ json: { paperCount: parts.length }, binary: { data: bin } }];" }, position: [4300, 400] },
  output: [{ paperCount: 3 }],
});

const writeReportHtml = node({
  type: 'n8n-nodes-base.readWriteFile',
  version: 1.1,
  config: { name: 'Write Report HTML', parameters: { operation: 'write', fileName: '/data/out/文献精读报告.html', dataPropertyName: 'data' }, position: [4500, 400] },
  output: [{}],
});

const compressReport = node({
  type: 'n8n-nodes-base.compression',
  version: 1.1,
  config: { name: 'Compress Report', parameters: { operation: 'compress', binaryPropertyName: 'data', outputFormat: 'zip', fileName: '文献精读报告.zip', binaryPropertyOutput: 'data' }, position: [4700, 400] },
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
      html: expr('<p>文献精读报告已生成，共 {{ $(\"Combine Report\").item.json.paperCount }} 篇文献。</p><p>附件为压缩包 <b>文献精读报告.zip</b>，解压后用浏览器打开（图文并茂、自包含）；完整文件也在本机 out/文献精读报告.html。</p>'),
      options: { attachments: 'data', appendAttribution: false },
    },
    credentials: { smtp: newCredential('QQ SMTP') },
    position: [4900, 400],
  },
  output: [{}],
});

export default workflow('litreview-all', '科学文献检索·精读一体')
  .add(formTrig)
  .to(genQuery)
  .to(search)
  .to(standardize)
  .to(enrich)
  .to(prepReview)
  .to(waitReview)
  .to(applyReview)
  .to(dl)
  .to(writePdf)
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
          .to(writeReportHtml)
          .to(compressReport)
          .to(sendEmail))))
    .onFalse(waitPoll.to(getResults)))
  .add(manualStart)
  .to(readPdfs);
