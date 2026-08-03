/**
 * Trie 前缀树 (Prefix Tree)
 * ============================================================================
 * 
 * 应用场景：
 * 1. 命令面板智能补全（输入 "git" → 提示 "git:commit", "git:push"...）
 * 2. 文件路径前缀搜索
 * 3. 代码自动补全的关键词前缀匹配
 * 
 * 算法原理：
 * Trie 是一种树形数据结构，每个节点代表一个字符，从根到叶的路径构成一个字符串。
 * 具有相同前缀的字符串共享路径，极大节省存储空间。
 * 
 * 时间复杂度：
 * - 插入：O(L)，L = 字符串长度
 * - 搜索：O(L)
 * - 前缀查找：O(L + K)，K = 匹配结果数
 * - 空间：O(ALPHABET_SIZE × 平均字符串长度 × 字符串数量)
 * 
 * 相比哈希表的优势：支持前缀搜索和自动补全
 * ============================================================================
 */

interface TrieNode {
  /** 子节点映射：字符 → 节点 */
  children: Map<string, TrieNode>;
  /** 是否是某个字符串的结尾 */
  isEnd: boolean;
  /** 完整字符串（仅在 isEnd 为 true 时有效） */
  word?: string;
  /** 该节点被访问的频率（用于排序） */
  frequency: number;
}

function createNode(): TrieNode {
  return {
    children: new Map(),
    isEnd: false,
    frequency: 0,
  };
}

export class Trie {
  private root: TrieNode;
  private size: number;

  constructor() {
    this.root = createNode();
    this.size = 0;
  }

  /**
   * 插入字符串
   * @param word 要插入的字符串
   * @param frequency 频率权重（越高排序越靠前）
   */
  insert(word: string, frequency = 0): void {
    if (!word) return;
    
    let node = this.root;
    for (const ch of word) {
      if (!node.children.has(ch)) {
        node.children.set(ch, createNode());
      }
      node = node.children.get(ch)!;
    }
    
    if (!node.isEnd) {
      this.size++;
    }
    
    node.isEnd = true;
    node.word = word;
    node.frequency = Math.max(node.frequency, frequency);
  }

  /**
   * 精确查找字符串是否存在
   */
  search(word: string): boolean {
    const node = this.findNode(word);
    return node !== null && node.isEnd;
  }

  /**
   * 查找是否有以 prefix 为前缀的字符串
   */
  startsWith(prefix: string): boolean {
    return this.findNode(prefix) !== null;
  }

  /**
   * 获取前缀匹配的所有字符串（自动补全核心）
   * @param prefix 前缀
   * @param maxResults 最大返回数量
   * @returns 按频率排序的匹配结果
   */
  autocomplete(prefix: string, maxResults = 10): string[] {
    const node = this.findNode(prefix);
    if (!node) return [];
    
    const results: { word: string; frequency: number }[] = [];
    this.collectWords(node, results, maxResults);
    
    // 按频率降序排列
    results.sort((a, b) => b.frequency - a.frequency);
    
    return results.map((r) => r.word);
  }

  /**
   * 获取前缀匹配的所有字符串（带高亮前缀）
   */
  autocompleteWithHighlight(
    prefix: string,
    maxResults = 10
  ): { word: string; highlighted: string }[] {
    const words = this.autocomplete(prefix, maxResults);
    const prefixLen = prefix.length;
    
    return words.map((word) => ({
      word,
      highlighted: `<mark>${word.slice(0, prefixLen)}</mark>${word.slice(prefixLen)}`,
    }));
  }

  /**
   * 删除字符串
   * @returns 是否删除成功（该词存在于 Trie 中）
   */
  delete(word: string): boolean {
    if (!this.search(word)) return false;
    this.deleteHelper(this.root, word, 0);
    return true;
  }

  /**
   * 获取 Trie 中存储的字符串总数
   */
  getSize(): number {
    return this.size;
  }

  /**
   * 获取所有存储的字符串
   */
  getAllWords(): string[] {
    const results: { word: string; frequency: number }[] = [];
    this.collectWords(this.root, results, Infinity);
    return results.map((r) => r.word);
  }

  /** 查找字符串对应的节点 */
  private findNode(word: string): TrieNode | null {
    let node = this.root;
    for (const ch of word) {
      if (!node.children.has(ch)) {
        return null;
      }
      node = node.children.get(ch)!;
    }
    return node;
  }

  /** DFS 收集节点下的所有单词 */
  private collectWords(
    node: TrieNode,
    results: { word: string; frequency: number }[],
    maxResults: number
  ): void {
    if (results.length >= maxResults) return;
    
    if (node.isEnd && node.word) {
      results.push({ word: node.word, frequency: node.frequency });
    }
    
    for (const child of node.children.values()) {
      this.collectWords(child, results, maxResults);
      if (results.length >= maxResults) return;
    }
  }

  /** 递归删除辅助函数 */
  private deleteHelper(node: TrieNode, word: string, index: number): boolean {
    if (index === word.length) {
      if (!node.isEnd) return false;
      node.isEnd = false;
      node.word = undefined;
      this.size--;
      return node.children.size === 0;
    }
    
    const ch = word[index];
    const child = node.children.get(ch);
    if (!child) return false;
    
    const shouldDeleteChild = this.deleteHelper(child, word, index + 1);
    
    if (shouldDeleteChild) {
      node.children.delete(ch);
      return !node.isEnd && node.children.size === 0;
    }
    
    return false;
  }
}

/**
 * 文件路径专用 Trie
 * 支持按路径层级分割搜索
 */
export class PathTrie extends Trie {
  /**
   * 插入文件路径，自动按频率加权
   */
  insertPath(path: string, frequency = 0): void {
    // 标准化路径分隔符
    const normalized = path.replace(/\\/g, '/');
    this.insert(normalized, frequency);
  }

  /**
   * 搜索包含某文件名（不限于前缀）的路径
   * 例如输入 "App" → 匹配 "src/App.tsx", "src/components/AppLayout.tsx"
   */
  searchByFilename(filename: string, maxResults = 10): string[] {
    const allWords = this.getAllWords();
    const matches: { word: string; score: number }[] = [];
    
    const lowerFilename = filename.toLowerCase();
    
    for (const word of allWords) {
      const parts = word.split('/');
      let bestScore = -1;
      
      for (const part of parts) {
        const lowerPart = part.toLowerCase();
        if (lowerPart.startsWith(lowerFilename)) {
          bestScore = Math.max(bestScore, lowerFilename.length / part.length);
        } else if (lowerPart.includes(lowerFilename)) {
          bestScore = Math.max(bestScore, lowerFilename.length / part.length * 0.5);
        }
      }
      
      if (bestScore >= 0) {
        matches.push({ word, score: bestScore });
      }
    }
    
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, maxResults).map((m) => m.word);
  }
}
