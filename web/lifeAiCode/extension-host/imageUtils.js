/**
 * imageUtils —— 图片附件识别与 base64 编码
 *
 * 多模态支持：把 @ 引用的图片文件读为 data URL，
 * 以 OpenAI 多模态格式（image_url）发给支持视觉的 LLM。
 */

const path = require('path');
const fs = require('fs');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
/** 单张图片原始大小上限（base64 会再膨胀约 33%） */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * 判断路径是否为图片文件
 * @param {string} p
 */
function isImageFile(p) {
  return typeof p === 'string' && IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

/**
 * 读取图片并编码为 data URL
 * @param {string} absPath 本地绝对路径
 * @returns {Promise<{ success: boolean, dataUrl?: string, size?: number, error?: string }>}
 */
async function loadImageAsDataUrl(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    return { success: false, error: `不支持的图片格式: ${ext || '(无扩展名)'}` };
  }
  try {
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) {
      return { success: false, error: `路径不是文件: ${absPath}` };
    }
    if (stat.size > MAX_IMAGE_SIZE) {
      return { success: false, error: `图片过大（${(stat.size / 1048576).toFixed(1)}MB，上限 10MB）` };
    }
    const buffer = await fs.promises.readFile(absPath);
    return {
      success: true,
      dataUrl: `data:${MIME_MAP[ext]};base64,${buffer.toString('base64')}`,
      size: stat.size,
    };
  } catch (err) {
    return { success: false, error: `读取图片失败: ${err.message}` };
  }
}

/**
 * 把纯文本用户消息与图片附件组装为 LLM 消息 content：
 * 有图片时用 OpenAI 多模态数组格式，无图片时保持原字符串。
 * @param {string} text
 * @param {Array<{ name: string, dataUrl: string }>} images
 */
function buildUserContent(text, images) {
  if (!Array.isArray(images) || images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
  ];
}

module.exports = { isImageFile, loadImageAsDataUrl, buildUserContent, MAX_IMAGE_SIZE };
