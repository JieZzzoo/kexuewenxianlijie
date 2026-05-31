# 检索模块设计（输入 + 自动检索下载全文 PDF）

> 在现有 22 节点精读流水线**前面**加一段：输入问题 → 自动搜索 → **把整篇 PDF 下载进 `papers/`** → 交给现有流水线。
> 决策（2026-05-30）：① 两工作流串联；② 标准版（搜索 + 人工勾选精选库 + 仅下载选中项）。

## 核心难点与结论（已实测）

搜索 API 给的是**摘要/元数据**，难点是"拿到整篇 PDF 文件落地"。结论：

- **OpenAlex 搜索结果自带候选 PDF 直链**：每条 `results[].locations[]` 是一个数组，含 `pdf_url`（已聚合 Unpaywall 数据，覆盖 arXiv / 机构库 / 出版商 / ACL 等）。`best_oa_location.pdf_url` 是首选。
- **不能信 `is_oa` 标记**：同样标 OA，下载结果天差地别。必须**下载后校验文件头 `== '%PDF'`**，失败就换下一个候选链接。
- 实测下载（浏览器 UA + 跟随重定向）：
  - ✅ arXiv `arxiv.org/pdf/<id>`（真 PDF，永远可下）
  - ✅ Nature `nature.com/...pdf`（浏览器 UA 下 200）
  - ✅ Europe PMC `europepmc.org/articles/PMC<id>?pdf=render`（生物医学）
  - ❌ OUP/NAR、Cell/Elsevier 直链 → 403 HTML（Cloudflare 拦爬虫）
- **覆盖率诚实说明**：付费墙论文合法手段拿不到全文 → 跳过并记日志（图/表视觉分析必须有真 PDF，只有摘要没意义）。CS/ML（arXiv 多）命中率高。

## 架构：两个串联工作流

```
[新] litreview-search  ──(写 PDF 到 papers/)──▶  Execute Workflow ──▶ [现有] 科学文献精读报告 (id DpuJ7nNKgWXsmMhc)
```

两半各自独立可测；现有 22 节点流水线一行不改；规避长跑时 MCP 掉线。

## 新工作流 litreview-search 节点设计

| # | 节点 | 类型 | 说明 |
|---|---|---|---|
| 1 | 表单提交触发 | formTrigger | 输入模块：research_question(必填) / domain / max_papers / year范围。**复用甲方表单** |
| 2 | 标准化用户输入 | set | question/domain/max_papers/year_from/year_to。**复用甲方** |
| 3 | 生成检索式链 + DeepSeek | chainLlm + lmChatDeepSeek | 自然语言问题 → OpenAlex 检索式(JSON: queries/recommended_query)。**复用甲方** |
| 4 | 解析检索式 | code | 容错解析 LLM 输出取 recommended_query。**复用甲方** |
| 5 | 检索文献-OpenAlex | httpRequest | `GET https://api.openalex.org/works?search={query}&filter=open_access.is_oa:true,from_publication_date:{y1}-01-01,to_publication_date:{y2}-12-31&per-page={N}&mailto=...` |
| 6 | 标准化文献 | code | 抽 title/abstract/doi/year/authors **+ 候选 PDF 链接数组**（best_oa_location.pdf_url → 所有 locations[].pdf_url → 由 doi `10.48550/arxiv.x` 推 arxiv 直链）。还原 abstract_inverted_index |
| 7 | 准备人工复核 | code | 把候选(序号+标题+摘要)整理成列表给人看。**复用甲方模式** |
| 8 | 等待人工复核 | wait (resume:form) | 人工勾选「精选文献库」（输入保留的序号/ID）。对应需求 md「人工根据摘要复核」。**复用甲方模式** |
| 9 | 应用人工复核结果 | code | 过滤出选中的文献。**复用甲方模式** |
| 10 | ★ 下载+校验+回退 | code | 对每篇选中文献，按候选链接顺序：`this.helpers.httpRequest({url,encoding:'arraybuffer',followRedirect:true,headers:{'User-Agent':<browser>}})`；校验 `buf.slice(0,4)=='%PDF'`；成功即停、全失败标记 unavailable。可 Promise.all 并发（按篇）。输出 binary |
| 11 | ★ 写入 papers/ | readWriteFile (write) 或 code+fs | 写 `/data/papers/<标题清洗或DOI>.pdf`。文件名清洗非法字符 |
| 12 | 触发精读流水线 | executeWorkflow | 调用 id `DpuJ7nNKgWXsmMhc`（现有 22 节点）。一键直达邮件 |

### ★ 下载+校验 Code 逻辑骨架
```js
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
async function tryDownload(cands){
  for(const url of cands){
    try{
      const buf = await this.helpers.httpRequest({url, method:'GET', encoding:'arraybuffer',
        followRedirect:true, timeout:30000, headers:{'User-Agent':UA, Accept:'application/pdf,*/*'}});
      const b = Buffer.from(buf);
      if(b.slice(0,4).toString('latin1')==='%PDF') return b;   // 校验真 PDF
    }catch(e){/* 试下一个候选 */}
  }
  return null;  // 全失败 → 跳过该篇
}
```
- 候选顺序：arXiv 直链优先（最稳）→ best_oa_location.pdf_url → 其余 locations[].pdf_url。
- 文件名：`title.replace(/[\\/:*?"<>|]/g,'_').slice(0,120)+'.pdf'`，重名加序号。
- 落地目录 `/data/papers/`（容器内）= 宿主 `papers/`（compose 已挂载，`N8N_RESTRICT_FILE_ACCESS_TO=/data` 允许写）。

## 复用甲方 JSON 的部分（Chapter2_AutoResearch...json，34 节点）
- 直接借鉴：formTrigger 输入、生成检索式链(LLM)+解析检索式、OpenAlex httpRequest、abstract_inverted_index 还原、人工复核 Wait 三节点模式。
- 丢弃：它的去重/初筛/雪球扩展/精筛（标准版不需要）、它后半段分析+发邮件（我们有更强的 MinerU+真视觉版）。
- **甲方致命短板**：`标准化文献-OpenAlex` 只抽 abstract/doi/landing_page_url，**从不碰 PDF 链接** → 全程基于摘要。我们补上候选 PDF 链接 + 下载校验 = 核心增量。

## 构建进度 / 已验证（2026-05-30）

**Step 1 — 下载→papers/ 命运链路：✅ 已验证**（n8n wf `paWfrdhPzrWlzVBE`，已删）。真实下载，两条回退路径都按设计触发：arXiv abs 页(200 HTML)被 `%PDF` 校验挡下→回退 arXiv pdf 成功；OUP 直链 403→回退 Europe PMC 成功。n8n 用 filesystem 二进制模式存盘，`prepareBinaryData`+`readWriteFile` 写进 `/data/papers/` → 宿主 `papers/` 出现真 PDF。

**Step 2 — 真实 OpenAlex 搜索→下载核心：✅ 已验证**（n8n wf `litreview-search-core` id `TJQ6aibhKDOozGDk`，非交互测试器，保留）。query="protein language model" per-page=6：
- 加 **Europe PMC 富化**(DOI→PMCID→`?pdf=render`/`ncbi .../pdf/`) + 论文去重后，命中率 **1/5 → 3 篇真 PDF**：SignalP、DeepLoc(被 Europe PMC 救回，OUP 直链 403)、Efficient evolution of antibodies。重复 SignalP 记录被去重折叠。
- 真正付费墙的(Science ESM / Cell ProGen2，不在 PMC、非 OA)正确跳过 —— 诚实上限。
- **候选优先级(可下载性从高到低)**：arXiv 直链 → Europe PMC PMC(`?pdf=render`,`ncbi/pdf/`) → OpenAlex best_oa/locations pdf → open_access.oa_url(landing)。
- 关键源可下载性实测：arXiv ✅、Europe PMC ✅、Nature ✅、Cloudflare 出版商(OUP/Cell/Elsevier)❌403、bioRxiv 直链 ❌403。**Unpaywall 需真实 email**(占位 email 422)，且数据与 OpenAlex 重叠，故只用 Europe PMC 富化。
- OpenAlex/Europe PMC 的 `mailto`/contact email 用 `1736672988@qq.com`。

**已验证可用的 n8n 节点要点**：`this.helpers.httpRequest({encoding:'arraybuffer'})` 下载二进制 + `Buffer.from(resp).slice(0,5)=='%PDF-'` 校验；`this.helpers.prepareBinaryData(buf, name, 'application/pdf')` 造二进制；`readWriteFile`(v1.1, op write, fileName=expr `/data/papers/{{ $json.pdfFileName }}`, dataPropertyName 'data') 落盘；Code 里 `const self=this` 别名后在普通 function 内用 `self.helpers`（普通 function 丢 this）；`Promise.all` 按篇并发 OK。

**节点版本**：formTrigger 2.5 · httpRequest 4.4 · code v2(mode runOnceForAllItems) · readWriteFile 1.1 · wait 1.1(resume:form) · executeWorkflow 1.3 · set 3.4(manual)。

**handoff**：现有分析流 `lit-review-report` id `DpuJ7nNKgWXsmMhc`，入口 manualTrigger→`Read PDFs`(read `/data/papers/*.pdf`)。串联需给它加一个 `executeWorkflowTrigger` 也接到 `Read PDFs`，搜索流末尾用 executeWorkflow(source database, workflowId DpuJ7nNKgWXsmMhc, waitForSubWorkflow:false) 调它。

## 待定/构建期确认
- 人工复核交互：Wait `resume:form` 渲染候选清单，人工填保留项。沿用甲方具体实现（构建时再取其 3 节点代码）。
- 并发：下载按篇 Promise.all（task-runner 下 httpRequest+Promise.all 已验证可用）。
- handoff：Execute Workflow 同步调用现有流水线；现有流水线读 `papers/*.pdf` 起跑，无需改它。
