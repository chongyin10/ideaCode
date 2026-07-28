import { Node, NodeOptions, NodeStyle, NodeData, type NodeEvent } from './Node';
import { Port, PortOptions } from './Port';
import { Shape } from './Shape';

/**
 * 行配置接口 - 定义每一行的连接桩配置
 */
export interface RowConfig {
  /** 行ID */
  id: string;
  /** 左侧连接桩配置 */
  leftPort?: Omit<PortOptions, 'nodeId' | 'position'>;
  /** 右侧连接桩配置 */
  rightPort?: Omit<PortOptions, 'nodeId' | 'position'>;
  /** 行标签（可选，显示在左侧） */
  label?: string;
  /** 行自定义数据 */
  data?: Record<string, any>;
}

/**
 * 动态高度节点样式扩展
 */
export interface DynamicHeightNodeStyle extends NodeStyle {
  /** 行高 */
  rowHeight: number;
  /** 行间距 */
  rowGap: number;
  /** 头部高度（标签区域） */
  headerHeight: number;
  /** 底部内边距 */
  footerPadding: number;
  /** 左侧连接桩区域宽度 */
  leftPortAreaWidth: number;
  /** 右侧连接桩区域宽度 */
  rightPortAreaWidth: number;
  /** 行标签字体大小 */
  rowLabelFontSize: number;
  /** 行标签颜色 */
  rowLabelColor: string;
  /** 行悬停背景色 */
  rowHoverBackgroundColor: string;
  /** 行悬停边框颜色 */
  rowHoverBorderColor: string;
  /** 行边框圆角 */
  rowBorderRadius: number;
}

/**
 * 动态高度节点配置选项
 */
export interface DynamicHeightNodeOptions extends Omit<NodeOptions, 'style'> {
  /** 行配置数组 */
  rows: RowConfig[];
  /** 扩展样式 */
  style?: Partial<DynamicHeightNodeStyle>;
  /** 节点标签（显示在头部） */
  label?: string;
}

/**
 * 行数据接口
 */
export interface RowData {
  id: string;
  label?: string;
  leftPortId?: string;
  rightPortId?: string;
  data?: Record<string, any>;
}

/**
 * 动态高度节点数据接口
 */
export interface DynamicHeightNodeData extends NodeData {
  rows: RowData[];
  style: DynamicHeightNodeStyle;
}

/**
 * 动态高度节点事件接口
 */
export interface DynamicHeightNodeEvent extends NodeEvent {
  /** 点击的行ID（如果点击的是行区域） */
  rowId?: string;
  /** 点击的连接桩位置（left/right） */
  portSide?: 'left' | 'right';
}

/**
 * DynamicHeightNode - 动态高度节点类
 *
 * 特性：
 * - 节点高度根据行数自动计算
 * - 每行可配置左侧和/或右侧连接桩
 * - 支持行标签显示
 * - 支持动态添加/删除行
 * - 支持自定义行高和间距
 *
 * 使用示例：
 * ```typescript
 * const node = new DynamicHeightNode({
 *     id: 'dynamic-node-1',
 *     x: 100,
 *     y: 100,
 *     label: '处理节点',
 *     rows: [
 *         { id: 'row-1', label: '输入', leftPort: { id: 'in-1' }, rightPort: { id: 'out-1' } },
 *         { id: 'row-2', label: '处理', rightPort: { id: 'out-2' } },
 *         { id: 'row-3', label: '输出', leftPort: { id: 'in-2' }, rightPort: { id: 'out-3' } },
 *     ],
 *     style: { width: 200, rowHeight: 40 }
 * });
 * ```
 */
export class DynamicHeightNode extends Node {
  private rows: RowConfig[] = [];
  private rowDataMap: Map<string, RowData> = new Map();
  private extendedStyle: DynamicHeightNodeStyle;
  private leftPortIds: Set<string> = new Set();
  private rightPortIds: Set<string> = new Set();
  private hoveredRowIndex: number = -1; // 当前悬停的行索引

  // 默认扩展样式
  private static readonly DEFAULT_EXTENDED_STYLE: DynamicHeightNodeStyle = {
    ...DynamicHeightNode.getDefaultNodeStyle(),
    rowHeight: 36,
    rowGap: 4,
    headerHeight: 32,
    footerPadding: 8,
    leftPortAreaWidth: 20,
    rightPortAreaWidth: 20,
    rowLabelFontSize: 12,
    rowLabelColor: '#374151',
    rowHoverBackgroundColor: 'rgba(59, 130, 246, 0.08)',
    rowHoverBorderColor: 'rgba(59, 130, 246, 0.3)',
    rowBorderRadius: 4,
  };

  /**
   * 获取默认节点样式（从 Node 类继承）
   */
  private static getDefaultNodeStyle(): NodeStyle {
    return {
      width: 180,
      height: 60, // 将被动态计算覆盖
      backgroundColor: '#ffffff',
      borderColor: '#d1d5db',
      borderWidth: 1,
      borderRadius: 6,
      borderStyle: 'solid',
      dashPattern: [6, 4],
      animatedBorderColor: '#3b82f6',
      animatedDashPattern: [8, 4],
      animatedBorderSpeed: 1,
      textColor: '#1f2937',
      fontSize: 14,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      shadowColor: 'rgba(0, 0, 0, 0.1)',
      shadowBlur: 2,
      shadowOffsetX: 0,
      shadowOffsetY: 1,
      selectedBorderColor: '#3b82f6',
      selectedBorderWidth: 2,
      hoverBackgroundColor: '#f9fafb',
      shape: { type: Shape.Rect, borderRadius: 6 },
    };
  }

  constructor(options: DynamicHeightNodeOptions) {
    // 先计算高度，再调用父类构造函数
    const extendedStyle = {
      ...DynamicHeightNode.DEFAULT_EXTENDED_STYLE,
      ...options.style,
    };

    // 计算动态高度
    const dynamicHeight = DynamicHeightNode.calculateHeight(
      options.rows?.length || 0,
      extendedStyle
    );

    // 计算自动宽度（根据标签内容）
    const autoWidth = DynamicHeightNode.calculateAutoWidth(
      options.rows || [],
      extendedStyle
    );
    const finalWidth = Math.max(options.style?.width || autoWidth, autoWidth);

    // 合并样式，使用计算出的高度和自动宽度
    const mergedStyle: Partial<NodeStyle> = {
      ...options.style,
      width: finalWidth,
      height: dynamicHeight,
    };

    super({
      ...options,
      style: mergedStyle,
    });

    // 同步更新 extendedStyle 的宽度，确保连接桩位置计算正确
    this.extendedStyle = {
      ...extendedStyle,
      width: finalWidth,
    };
    this.rows = [...(options.rows || [])];

    // 初始化行和连接桩
    this.initializeRows();
  }

  /**
   * 计算节点高度
   */
  private static calculateHeight(
    rowCount: number,
    style: DynamicHeightNodeStyle
  ): number {
    if (rowCount === 0) {
      return style.headerHeight + style.footerPadding * 2;
    }
    const rowsTotalHeight =
      rowCount * style.rowHeight + (rowCount - 1) * style.rowGap;
    return style.headerHeight + rowsTotalHeight + style.footerPadding;
  }

  /**
   * 计算节点自动宽度（根据行标签和连接桩标签内容）
   * 当行存在连接桩标签时，行标签会被隐藏
   */
  private static calculateAutoWidth(
    rows: RowConfig[],
    style: DynamicHeightNodeStyle
  ): number {
    if (rows.length === 0) {
      return style.width;
    }

    // 创建一个临时 canvas 来测量文字宽度
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return style.width;
    }

    // 设置字体样式
    ctx.font = `${style.rowLabelFontSize}px ${style.fontFamily}`;
    
    // 标签与连接桩之间的间距
    const labelToPortGap = 8;
    // 两侧标签之间的最小间距（当行标签被隐藏时使用）
    const minGapBetweenLabels = 16;

    // 对每一行计算所需宽度，然后取最大值
    let maxRowWidth = 0;
    rows.forEach((row) => {
      // 检查是否有连接桩标签（只要有 lable 字段即可）
      const hasLeftPortLabel = !!row.leftPort?.lable;
      const hasRightPortLabel = !!row.rightPort?.lable;
      const hasPortLabel = hasLeftPortLabel || hasRightPortLabel;

      let leftLabelWidth = 0;
      let rightLabelWidth = 0;

      // 计算左侧标签宽度（无论 inside 还是 outside，都参与宽度计算）
      if (hasLeftPortLabel && row.leftPort?.lable) {
        leftLabelWidth = ctx.measureText(row.leftPort.lable).width;
      }

      // 计算右侧标签宽度（无论 inside 还是 outside，都参与宽度计算）
      if (hasRightPortLabel && row.rightPort?.lable) {
        rightLabelWidth = ctx.measureText(row.rightPort.lable).width;
      }

      let contentWidth: number;

      if (hasPortLabel) {
        // 存在连接桩标签时，行标签被隐藏
        // 布局：连接桩区 + 内侧标签区 + 间距 + 内侧标签区 + 连接桩区
        const leftPart = hasLeftPortLabel ? labelToPortGap + leftLabelWidth : 0;
        const rightPart = hasRightPortLabel ? labelToPortGap + rightLabelWidth : 0;
        contentWidth = leftPart + minGapBetweenLabels + rightPart;
      } else {
        // 没有连接桩标签时，只显示行标签
        const rowLabelWidth = row.label ? ctx.measureText(row.label).width : 0;
        contentWidth = rowLabelWidth + 32; // 两侧内边距
      }

      const rowWidth = style.leftPortAreaWidth + contentWidth + style.rightPortAreaWidth;
      maxRowWidth = Math.max(maxRowWidth, rowWidth);
    });

    // 如果没有行需要特殊计算，使用默认宽度
    if (maxRowWidth === 0) {
      maxRowWidth = style.width;
    }

    // 返回计算宽度（不小于默认宽度）
    return Math.max(style.width, maxRowWidth);
  }

  /**
   * 初始化所有行和连接桩
   */
  private initializeRows(): void {
    this.rows.forEach((row, index) => {
      this.createRow(row, index);
    });
  }

  /**
   * 创建单行及其连接桩
   */
  private createRow(config: RowConfig, index: number): void {
    const rowData: RowData = {
      id: config.id,
      label: config.label,
      data: config.data ? { ...config.data } : {},
    };

    // 计算行的Y位置（相对于节点中心）
    const rowY = this.calculateRowY(index);

    // 创建左侧连接桩（位于节点左边缘，与边缘对齐）
    if (config.leftPort) {
      const portId = config.leftPort.id || `${this.id}-row-${config.id}-left`;
      this.addPort({
        ...config.leftPort,
        id: portId,
        position: {
          x: -this.extendedStyle.width / 2,
          y: rowY,
        },
        visible: true,
      });
      rowData.leftPortId = portId;
      this.leftPortIds.add(portId);
    }

    // 创建右侧连接桩（位于节点右边缘，与边缘对齐）
    if (config.rightPort) {
      const portId = config.rightPort.id || `${this.id}-row-${config.id}-right`;
      this.addPort({
        ...config.rightPort,
        id: portId,
        position: {
          x: this.extendedStyle.width / 2,
          y: rowY,
        },
        visible: true,
      });
      rowData.rightPortId = portId;
      this.rightPortIds.add(portId);
    }

    this.rowDataMap.set(config.id, rowData);
  }

  /**
   * 计算行的Y坐标（相对于节点中心）
   * 连接桩在行的垂直居中位置
   */
  private calculateRowY(index: number): number {
    const nodeHeight = this.getStyle().height;
    const headerHeight = this.extendedStyle.headerHeight;
    const rowHeight = this.extendedStyle.rowHeight;
    const rowGap = this.extendedStyle.rowGap;
    
    // 内容区域起始位置（相对于节点中心）
    const contentStartY = -nodeHeight / 2 + headerHeight;
    // 行的顶部位置
    const rowTop = contentStartY + index * (rowHeight + rowGap);
    // 行的中心位置（连接桩应该在这里，与绘制逻辑一致）
    return rowTop + rowHeight / 2;
  }

  /**
   * 获取扩展样式
   */
  getExtendedStyle(): DynamicHeightNodeStyle {
    return { ...this.extendedStyle };
  }

  /**
   * 更新扩展样式
   */
  updateExtendedStyle(style: Partial<DynamicHeightNodeStyle>): void {
    this.extendedStyle = { ...this.extendedStyle, ...style };
    // 重新计算高度
    const newHeight = DynamicHeightNode.calculateHeight(
      this.rows.length,
      this.extendedStyle
    );
    this.updateStyle({ height: newHeight });
    // 重新布局所有连接桩
    this.relayoutAllRows();
  }

  /**
   * 重新布局所有行
   */
  private relayoutAllRows(): void {
    this.rows.forEach((row, index) => {
      const rowData = this.rowDataMap.get(row.id);
      if (!rowData) return;

      const rowY = this.calculateRowY(index);

      // 更新左侧连接桩位置（位于节点左边缘）
      if (rowData.leftPortId) {
        const port = this.getPort(rowData.leftPortId);
        if (port) {
          port.setPosition({
            x: -this.extendedStyle.width / 2,
            y: rowY,
          });
        }
      }

      // 更新右侧连接桩位置（位于节点右边缘）
      if (rowData.rightPortId) {
        const port = this.getPort(rowData.rightPortId);
        if (port) {
          port.setPosition({
            x: this.extendedStyle.width / 2,
            y: rowY,
          });
        }
      }
    });
  }

  /**
   * 获取所有行配置
   */
  getRows(): RowConfig[] {
    return [...this.rows];
  }

  /**
   * 获取行数据
   */
  getRowData(rowId: string): RowData | undefined {
    const data = this.rowDataMap.get(rowId);
    return data ? { ...data } : undefined;
  }

  /**
   * 添加新行
   * @param config 行配置
   * @param index 插入位置（默认添加到末尾）
   */
  addRow(config: RowConfig, index?: number): void {
    const insertIndex = index !== undefined ? index : this.rows.length;
    this.rows.splice(insertIndex, 0, config);

    // 更新高度
    const newHeight = DynamicHeightNode.calculateHeight(
      this.rows.length,
      this.extendedStyle
    );
    this.updateStyle({ height: newHeight });

    // 重新创建所有行（因为位置都变了）
    this.clearAllRowPorts();
    this.rowDataMap.clear();
    this.initializeRows();
  }

  /**
   * 移除行
   * @param rowId 行ID
   */
  removeRow(rowId: string): boolean {
    const index = this.rows.findIndex((r) => r.id === rowId);
    if (index === -1) return false;

    this.rows.splice(index, 1);

    // 更新高度
    const newHeight = DynamicHeightNode.calculateHeight(
      this.rows.length,
      this.extendedStyle
    );
    this.updateStyle({ height: newHeight });

    // 重新创建所有行
    this.clearAllRowPorts();
    this.rowDataMap.clear();
    this.initializeRows();

    return true;
  }

  /**
   * 更新行
   * @param rowId 行ID
   * @param updates 更新的配置
   */
  updateRow(rowId: string, updates: Partial<RowConfig>): boolean {
    const index = this.rows.findIndex((r) => r.id === rowId);
    if (index === -1) return false;

    const oldConfig = this.rows[index];
    const newConfig = { ...oldConfig, ...updates, id: rowId };
    this.rows[index] = newConfig;

    // 如果连接桩配置有变化，需要重新创建
    const needsRecreate =
      updates.leftPort !== undefined || updates.rightPort !== undefined;

    if (needsRecreate) {
      this.clearAllRowPorts();
      this.rowDataMap.clear();
      this.initializeRows();
    } else {
      // 只更新数据
      const rowData = this.rowDataMap.get(rowId);
      if (rowData) {
        if (updates.label !== undefined) rowData.label = updates.label;
        if (updates.data !== undefined) rowData.data = { ...updates.data };
        this.rowDataMap.set(rowId, rowData);
      }
    }

    return true;
  }

  /**
   * 获取行数
   */
  getRowCount(): number {
    return this.rows.length;
  }

  /**
   * 获取指定行的连接桩ID
   * @param rowId 行ID
   * @param side 'left' | 'right'
   */
  getRowPortId(rowId: string, side: 'left' | 'right'): string | undefined {
    const rowData = this.rowDataMap.get(rowId);
    if (!rowData) return undefined;
    return side === 'left' ? rowData.leftPortId : rowData.rightPortId;
  }

  /**
   * 获取指定行的连接桩
   * @param rowId 行ID
   * @param side 'left' | 'right'
   */
  getRowPort(rowId: string, side: 'left' | 'right'): Port | undefined {
    const portId = this.getRowPortId(rowId, side);
    if (!portId) return undefined;
    return this.getPort(portId);
  }

  /**
   * 检查连接桩是否在左侧
   */
  isLeftPort(portId: string): boolean {
    return this.leftPortIds.has(portId);
  }

  /**
   * 检查连接桩是否在右侧
   */
  isRightPort(portId: string): boolean {
    return this.rightPortIds.has(portId);
  }

  /**
   * 清空所有行的连接桩
   */
  private clearAllRowPorts(): void {
    this.leftPortIds.forEach((id) => this.removePort(id));
    this.rightPortIds.forEach((id) => this.removePort(id));
    this.leftPortIds.clear();
    this.rightPortIds.clear();
  }

  /**
   * 绘制节点（重写父类方法）
   */
  draw(ctx: CanvasRenderingContext2D): void {
    const style = this.getStyle();
    const pos = this.getPosition();

    ctx.save();

    // 绘制阴影
    if (style.shadowBlur > 0) {
      ctx.shadowColor = style.shadowColor;
      ctx.shadowBlur = style.shadowBlur;
      ctx.shadowOffsetX = style.shadowOffsetX;
      ctx.shadowOffsetY = style.shadowOffsetY;
    }

    // 绘制节点背景
    this.drawBackground(ctx, pos.x, pos.y, style.width, style.height);

    // 绘制头部
    this.drawHeader(ctx, pos.x, pos.y, style.width);

    // 绘制分隔线
    this.drawSeparator(ctx, pos.x, pos.y, style.width);

    // 绘制行
    this.drawRows(ctx, pos.x, pos.y, style.width);

    ctx.restore();

    // 绘制所有连接桩
    this.drawAllPorts(ctx);

    // 绘制连接桩标签
    this.drawPortLabels(ctx);
  }

  /**
   * 绘制节点背景
   */
  private drawBackground(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    const style = this.getStyle();

    ctx.beginPath();
    const radius = style.borderRadius;
    const left = x - width / 2;
    const top = y - height / 2;

    // 圆角矩形路径
    ctx.moveTo(left + radius, top);
    ctx.lineTo(left + width - radius, top);
    ctx.quadraticCurveTo(left + width, top, left + width, top + radius);
    ctx.lineTo(left + width, top + height - radius);
    ctx.quadraticCurveTo(left + width, top + height, left + width - radius, top + height);
    ctx.lineTo(left + radius, top + height);
    ctx.quadraticCurveTo(left, top + height, left, top + height - radius);
    ctx.lineTo(left, top + radius);
    ctx.quadraticCurveTo(left, top, left + radius, top);
    ctx.closePath();

    // 填充
    ctx.fillStyle = this.getHovered()
      ? style.hoverBackgroundColor
      : style.backgroundColor;
    ctx.fill();

    // 边框
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = this.getSelected() ? style.selectedBorderWidth : style.borderWidth;
    ctx.strokeStyle = this.getSelected() ? style.selectedBorderColor : style.borderColor;
    ctx.stroke();
  }

  /**
   * 绘制头部
   */
  private drawHeader(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number
  ): void {
    const style = this.getStyle();
    const headerHeight = this.extendedStyle.headerHeight;
    const top = y - this.getStyle().height / 2;

    // 头部背景（略深的颜色）
    ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
    ctx.beginPath();
    ctx.rect(x - width / 2 + 1, top + 1, width - 2, headerHeight - 1);
    ctx.fill();

    // 绘制标签
    if (this.getLabel()) {
      ctx.fillStyle = style.textColor;
      ctx.font = `${style.fontSize}px ${style.fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.getLabel(), x, top + headerHeight / 2);
    }
  }

  /**
   * 绘制分隔线
   */
  private drawSeparator(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number
  ): void {
    const top = y - this.getStyle().height / 2;
    const headerBottom = top + this.extendedStyle.headerHeight;

    ctx.beginPath();
    ctx.moveTo(x - width / 2 + 8, headerBottom);
    ctx.lineTo(x + width / 2 - 8, headerBottom);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * 绘制所有行
   */
  private drawRows(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number
  ): void {
    const top = y - this.getStyle().height / 2;
    const contentTop = top + this.extendedStyle.headerHeight;

    this.rows.forEach((row, index) => {
      const rowY = contentTop + index * (this.extendedStyle.rowHeight + this.extendedStyle.rowGap);
      this.drawRow(ctx, row, x, rowY, width, index);
    });
  }

  /**
   * 绘制单行
   */
  private drawRow(
    ctx: CanvasRenderingContext2D,
    row: RowConfig,
    x: number,
    rowY: number,
    width: number,
    index: number
  ): void {
    const rowHeight = this.extendedStyle.rowHeight;
    const leftPortWidth = this.extendedStyle.leftPortAreaWidth;
    const rightPortWidth = this.extendedStyle.rightPortAreaWidth;
    const contentWidth = width - leftPortWidth - rightPortWidth;

    // 交替行背景
    if (index % 2 === 1) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
      ctx.fillRect(x - width / 2 + 1, rowY, width - 2, rowHeight);
    }

    // 悬停行效果（高亮背景和边框）
    if (index === this.hoveredRowIndex) {
      const radius = this.extendedStyle.rowBorderRadius;
      const left = x - width / 2 + 2;
      const top = rowY + 1;
      const w = width - 4;
      const h = rowHeight - 2;

      // 绘制悬停背景
      ctx.fillStyle = this.extendedStyle.rowHoverBackgroundColor;
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, radius);
      ctx.fill();

      // 绘制悬停边框
      ctx.strokeStyle = this.extendedStyle.rowHoverBorderColor;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 检查当前行是否有连接桩标签（只要有 lable 字段，无论 inside/outside 都隐藏行标签）
    const hasLeftPortLabel = !!row.leftPort?.lable;
    const hasRightPortLabel = !!row.rightPort?.lable;
    const hasPortLabel = hasLeftPortLabel || hasRightPortLabel;

    // 绘制行标签（当存在连接桩标签时，隐藏行本身的 label）
    if (row.label && !hasPortLabel) {
      // 行标签始终居中
      const labelX = x;
      const labelY = rowY + rowHeight / 2;
      
      // 计算可用宽度
      const maxWidth = contentWidth - 16;

      ctx.fillStyle = this.extendedStyle.rowLabelColor;
      ctx.font = `${this.extendedStyle.rowLabelFontSize}px ${this.getStyle().fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // 截断文字
      let displayLabel = row.label;
      const metrics = ctx.measureText(displayLabel);
      if (metrics.width > maxWidth) {
        let truncated = displayLabel;
        while (ctx.measureText(truncated + '...').width > maxWidth && truncated.length > 0) {
          truncated = truncated.slice(0, -1);
        }
        displayLabel = truncated + '...';
      }

      ctx.fillText(displayLabel, labelX, labelY);
    }
  }

  /**
   * 根据点获取行索引
   * @param point 坐标点
   * @returns 行索引或 -1
   */
  getRowIndexAtPoint(point: { x: number; y: number }): number {
    const pos = this.getPosition();
    const style = this.getStyle();
    const top = pos.y - style.height / 2 + this.extendedStyle.headerHeight;
    const contentHeight =
      this.rows.length * this.extendedStyle.rowHeight +
      (this.rows.length - 1) * this.extendedStyle.rowGap;

    // 检查是否在内容区域
    if (
      point.y < top ||
      point.y > top + contentHeight ||
      point.x < pos.x - style.width / 2 ||
      point.x > pos.x + style.width / 2
    ) {
      return -1;
    }

    const relativeY = point.y - top;
    const rowIndex = Math.floor(
      relativeY / (this.extendedStyle.rowHeight + this.extendedStyle.rowGap)
    );

    return rowIndex >= 0 && rowIndex < this.rows.length ? rowIndex : -1;
  }

  /**
   * 根据点获取行ID
   */
  getRowIdAtPoint(point: { x: number; y: number }): string | undefined {
    const index = this.getRowIndexAtPoint(point);
    if (index === -1) return undefined;
    return this.rows[index]?.id;
  }

  /**
   * 设置当前悬停的行索引
   * @param index 行索引，-1 表示没有悬停
   */
  setHoveredRow(index: number): void {
    this.hoveredRowIndex = index;
  }

  /**
   * 获取当前悬停的行索引
   * @returns 行索引，-1 表示没有悬停
   */
  getHoveredRow(): number {
    return this.hoveredRowIndex;
  }

  /**
   * 序列化为 JSON
   */
  toJSON(): DynamicHeightNodeData {
    const baseData = super.toJSON();
    const rows: RowData[] = this.rows.map((row) => {
      const rowData = this.rowDataMap.get(row.id);
      return {
        id: row.id,
        label: row.label,
        leftPortId: rowData?.leftPortId,
        rightPortId: rowData?.rightPortId,
        data: rowData?.data ? { ...rowData.data } : undefined,
      };
    });

    return {
      ...baseData,
      rows,
      style: { ...this.extendedStyle },
    };
  }

  /**
   * 从 JSON 创建节点
   */
  static fromJSON(data: DynamicHeightNodeData): DynamicHeightNode {
    const rows: RowConfig[] = data.rows.map((row) => ({
      id: row.id,
      label: row.label,
      leftPort: row.leftPortId ? { id: row.leftPortId } : undefined,
      rightPort: row.rightPortId ? { id: row.rightPortId } : undefined,
      data: row.data,
    }));

    return new DynamicHeightNode({
      id: data.id,
      x: data.position.x,
      y: data.position.y,
      label: data.label,
      rows,
      style: data.style,
      data: data.data,
    });
  }

  /**
   * 克隆节点
   */
  clone(newId?: string): DynamicHeightNode {
    return new DynamicHeightNode({
      id: newId || `${this.id}_clone`,
      x: this.getPosition().x + 20,
      y: this.getPosition().y + 20,
      label: this.getLabel(),
      rows: this.rows.map((row) => ({ ...row })),
      style: { ...this.extendedStyle },
      data: this.getData(),
    });
  }

  /**
   * 绘制连接桩标签
   * 在连接桩旁边显示标签文字
   */
  private drawPortLabels(ctx: CanvasRenderingContext2D): void {
    const pos = this.getPosition();
    const ports = this.getAllPorts();
    const style = this.getStyle();

    ctx.save();
    ctx.font = `${this.extendedStyle.rowLabelFontSize}px ${style.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.extendedStyle.rowLabelColor;

    ports.forEach((port) => {
      const label = port.getPortLabel();
      if (!label) return;

      // 获取连接桩的世界坐标
      const portPos = port.getPosition();
      let portWorldX: number;
      let portWorldY: number;

      if (typeof portPos === 'object' && 'x' in portPos && 'y' in portPos) {
        portWorldX = pos.x + portPos.x;
        portWorldY = pos.y + portPos.y;
      } else {
        return; // 不支持的位置类型
      }

      // 判断连接桩方位
      const isLeftPort = portPos.x < 0;
      const labelPosition = port.getPortLabelPosition();
      const labelOffset = 8; // 外侧标签到节点边框的距离
      const innerLabelGap = 8; // 内侧标签与连接桩之间的间距（较小，靠近边框）

      // 计算节点边框的 X 坐标
      const halfWidth = style.width / 2;
      const leftBorderX = pos.x - halfWidth;
      const rightBorderX = pos.x + halfWidth;

      switch (labelPosition) {
        case 'inside':
          // 内侧：标签在连接桩内侧（朝向节点中心方向）
          ctx.textBaseline = 'middle';
          if (isLeftPort) {
            // 左侧连接桩：标签在连接桩右侧（内侧），靠近连接桩
            ctx.textAlign = 'left';
            const labelX = portWorldX + innerLabelGap;
            ctx.fillText(label, labelX, portWorldY);
          } else {
            // 右侧连接桩：标签在连接桩左侧（内侧），靠近连接桩
            ctx.textAlign = 'right';
            const labelX = portWorldX - innerLabelGap;
            ctx.fillText(label, labelX, portWorldY);
          }
          break;

        case 'top':
          // 上面：标签在连接桩上方
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, portWorldX, portWorldY - labelOffset);
          break;

        case 'bottom':
          // 下面：标签在连接桩下方
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(label, portWorldX, portWorldY + labelOffset);
          break;

        case 'outside':
        default:
          // 外侧：标签在连接桩外侧（远离节点方向）
          ctx.textBaseline = 'middle';
          if (isLeftPort) {
            // 左侧连接桩：标签在左侧（外侧），距离左边框 8px
            ctx.textAlign = 'right';
            ctx.fillText(label, leftBorderX - labelOffset, portWorldY);
          } else {
            // 右侧连接桩：标签在右侧（外侧），距离右边框 8px
            ctx.textAlign = 'left';
            ctx.fillText(label, rightBorderX + labelOffset, portWorldY);
          }
          break;
      }
    });

    ctx.restore();
  }
}

export default DynamicHeightNode;
