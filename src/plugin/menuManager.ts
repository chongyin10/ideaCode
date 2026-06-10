/**
 * 菜单管理器 - 插件扩展点
 *
 * 支持插件向不同上下文（context）注册菜单项。
 * 内置上下文：
 * - fileTree：文件树右键菜单
 *
 * 菜单项按 group 排序，不同 group 之间自动插入分隔线。
 */

export interface MenuContribution {
  id: string;
  label: string;
  group: string;
  /** group 内排序权重，越小越靠前 */
  order?: number;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  /** 子菜单 */
  children?: MenuContribution[];
  /** 点击时执行的命令 ID */
  command?: string;
  /** 直接回调（优先级高于 command） */
  onClick?: () => void;
  /** 条件显示 */
  when?: (contextData: unknown) => boolean;
}

interface MenuRegistration {
  item: MenuContribution;
  dispose: () => void;
}

class MenuManagerCore {
  private menus = new Map<string, MenuRegistration[]>();

  /** 向指定上下文注册菜单项 */
  register(context: string, item: MenuContribution): () => void {
    const list = this.menus.get(context) ?? [];
    const reg: MenuRegistration = {
      item,
      dispose: () => {
        const idx = list.findIndex((r) => r.item.id === item.id);
        if (idx >= 0) list.splice(idx, 1);
      },
    };
    list.push(reg);
    this.menus.set(context, list);
    return reg.dispose;
  }

  /** 获取指定上下文的所有菜单项（已排序） */
  getItems(context: string, contextData?: unknown): MenuContribution[] {
    const list = this.menus.get(context) ?? [];
    return list
      .map((r) => r.item)
      .filter((item) => !item.when || item.when(contextData))
      .sort((a, b) => {
        const ga = a.group || '';
        const gb = b.group || '';
        if (ga !== gb) return ga.localeCompare(gb);
        return (a.order ?? 0) - (b.order ?? 0);
      });
  }

  /** 清空指定上下文 */
  clear(context: string) {
    this.menus.delete(context);
  }

  /** 清空所有 */
  clearAll() {
    this.menus.clear();
  }
}

let instance: MenuManagerCore | null = null;

export function getMenuManager(): MenuManagerCore {
  if (!instance) instance = new MenuManagerCore();
  return instance;
}

export function resetMenuManager() {
  instance = null;
}

/** 将插件 MenuContribution 转换为 ContextMenu 的 MenuItem 格式 */
export function contributionToMenuItem(c: MenuContribution): {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  group?: string;
  order?: number;
  children?: any[];
  command?: string;
  onClick?: () => void;
} {
  return {
    id: c.id,
    label: c.label,
    icon: c.icon,
    shortcut: c.shortcut,
    disabled: c.disabled,
    group: c.group,
    order: c.order,
    children: c.children?.map(contributionToMenuItem),
    command: c.command,
    onClick: c.onClick,
  };
}
