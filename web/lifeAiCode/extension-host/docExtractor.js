/**
 * docExtractor —— 从 Office / PDF 文档中提取纯文本
 *
 * 背景：DeepSeek 等纯文本 LLM 无法读取 docx/pdf/xlsx/pptx 二进制内容，
 * 需要在扩展宿主（Node 进程）先转成纯文本再交给大模型。
 *
 * 支持：.docx（mammoth）、.pdf（pdf-parse，锁定 1.x，2.x 依赖 DOM API 无法在 Node 运行）、
 *       .xlsx/.xls（SheetJS xlsx，转成 CSV 文本）、.pptx（jszip 解包取幻灯片文本）
 * 不支持：.doc/.ppt 老二进制格式（无可靠纯 JS 解析方案）
 *
 * 依赖安装在 IDE 根目录 node_modules，扩展宿主按 Node 向上查找规则解析。
 * 懒加载 require，缺依赖时返回友好错误而不是抛异常。
 */

const path = require('path');
const fs = require('fs');

/** 提取文本的最大字符数，防止 token 爆炸 */
const MAX_TEXT_LENGTH = 20000;

/** 可提取文本的文档扩展名 */
const SUPPORTED_EXTS = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.pptx']);
/** 所有"文档类"扩展名（含明确不支持的，用于给出针对性提示） */
const DOCUMENT_EXTS = new Set(['.docx', '.pdf', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']);

/**
 * 判断路径是否为文档类文件
 * @param {string} p
 */
function isDocumentFile(p) {
  return typeof p === 'string' && DOCUMENT_EXTS.has(path.extname(p).toLowerCase());
}

/** 还原 XML 实体（pptx 幻灯片文本用） */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Excel（.xlsx/.xls）：每个 sheet 转成 CSV 文本 */
async function extractExcelText(absPath) {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    return { success: false, error: '缺少 xlsx 依赖，请在 IDE 根目录执行 npm i xlsx' };
  }
  const buffer = await fs.promises.readFile(absPath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    if (csv.trim()) {
      parts.push(`--- 工作表: ${sheetName} ---\n${csv.trim()}`);
    }
  }
  return { success: true, text: parts.join('\n\n') || '(表格内容为空)' };
}

/** PowerPoint（.pptx）：解包 zip，按页提取幻灯片中的 <a:t> 文本 */
async function extractPptxText(absPath) {
  let JSZip;
  try {
    JSZip = require('jszip');
  } catch {
    return { success: false, error: '缺少 jszip 依赖，请在 IDE 根目录执行 npm i jszip' };
  }
  const buffer = await fs.promises.readFile(absPath);
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (slideFiles.length === 0) {
    return { success: false, error: 'pptx 中未找到幻灯片内容' };
  }
  const parts = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]));
    const pageText = texts.filter((t) => t.trim()).join('\n');
    parts.push(`--- 幻灯片 ${name.match(/\d+/)[0]} ---${pageText ? `\n${pageText}` : ' (无文本)'}`);
  }
  return { success: true, text: parts.join('\n\n') };
}

/**
 * 提取文档纯文本
 * @param {string} absPath 本地绝对路径
 * @returns {Promise<{ success: boolean, text?: string, truncated?: boolean, size?: number, error?: string }>}
 */
async function extractDocumentText(absPath) {
  const ext = path.extname(absPath).toLowerCase();

  if (ext === '.doc' || ext === '.ppt') {
    return { success: false, error: `不支持 ${ext} 旧格式，请先用办公软件另存为 ${ext}x` };
  }
  if (!SUPPORTED_EXTS.has(ext)) {
    return { success: false, error: `不支持的文档格式: ${ext || '(无扩展名)'}` };
  }

  let stat;
  try {
    stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) {
      return { success: false, error: `路径不是文件: ${absPath}` };
    }
  } catch (err) {
    return { success: false, error: `文件不存在或不可读: ${err.message}` };
  }

  try {
    let text = '';
    if (ext === '.docx') {
      // 懒加载：仅在真正用到时 require，缺库时给出明确提示
      let mammoth;
      try {
        mammoth = require('mammoth');
      } catch {
        return { success: false, error: '缺少 mammoth 依赖，请在 IDE 根目录执行 npm i mammoth' };
      }
      const result = await mammoth.extractRawText({ path: absPath });
      text = result.value || '';
    } else if (ext === '.pdf') {
      let pdfParse;
      try {
        pdfParse = require('pdf-parse');
      } catch {
        return { success: false, error: '缺少 pdf-parse 依赖，请在 IDE 根目录执行 npm i pdf-parse@1.1.1' };
      }
      const buffer = await fs.promises.readFile(absPath);
      const result = await pdfParse(buffer);
      text = result.text || '';
    } else if (ext === '.xlsx' || ext === '.xls') {
      const result = await extractExcelText(absPath);
      if (!result.success) return result;
      text = result.text;
    } else {
      const result = await extractPptxText(absPath);
      if (!result.success) return result;
      text = result.text;
    }

    const truncated = text.length > MAX_TEXT_LENGTH;
    if (truncated) text = text.slice(0, MAX_TEXT_LENGTH);
    return { success: true, text: text.trim(), truncated, size: stat.size };
  } catch (err) {
    return { success: false, error: `文档解析失败: ${err.message}` };
  }
}

module.exports = { extractDocumentText, isDocumentFile, MAX_TEXT_LENGTH };
