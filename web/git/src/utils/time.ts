/**
 * 将时间戳格式化为相对时间（如“1小时前”、“2周前”）
 */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;

  return `${Math.floor(months / 12)}年前`;
}
