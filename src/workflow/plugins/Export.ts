import { Graph } from '../core/Graph';

/**
 * 导出格式类型
 */
export type ExportFormat = 'png' | 'jpeg' | 'svg';

/**
 * 导出选项
 */
export interface ExportOptions {
    /**
     * 导出图片格式，默认 'png'
     */
    format?: ExportFormat;
    /**
     * 导出图片质量（0-1），仅对 jpeg 有效，默认 1
     */
    quality?: number;
    /**
     * 导出图片的宽度，默认使用画布实际宽度
     */
    width?: number | string;
    /**
     * 导出图片的高度，默认使用画布实际高度
     */
    height?: number | string;
    /**
     * 背景颜色，默认透明（png/svg）或白色（jpeg）
     */
    backgroundColor?: string;
    /**
     * 缩放比例，默认 1
     */
    scale?: number;
    /**
     * 是否包含网格背景，默认 false
     */
    includeGrid?: boolean;
    /**
     * 导出区域的内边距，默认 10
     */
    padding?: number;
    /**
     * 是否只导出画布可视区域（视口），默认 false
     * 为 true 时，只导出当前可见的内容区域
     */
    view?: boolean;
}

/**
 * SVG 导出选项
 */
export interface SVGExportOptions extends Omit<ExportOptions, 'format' | 'quality'> {
    /**
     * 是否复制外部样式表中的样式到 SVG，默认 true
     */
    copyStyles?: boolean;
    /**
     * 额外的 CSS 样式字符串
     */
    extraStyles?: string;
}

/**
 * 插件接口
 */
export interface Plugin {
    /** 插件名称 */
    name: string;
    /** 安装插件 */
    install(graph: Graph): void;
    /** 卸载插件 */
    uninstall(): void;
}

/**
 * Export - 导出插件
 *
 * 将画布内容导出为图片格式：
 * - PNG: 支持透明背景
 * - JPEG: 有损压缩，不支持透明
 * - SVG: 矢量格式，可缩放
 *
 * 使用示例：
 * ```typescript
 * const exportPlugin = new Export();
 * graph.use(exportPlugin);
 *
 * // 导出为 PNG
 * const pngDataUrl = exportPlugin.toPNG({ scale: 2 });
 *
 * // 导出为 SVG（默认复制外部样式）
 * const svgString = exportPlugin.toSVG({ width: 800, height: 600 });
 *
 * // 下载图片
 * exportPlugin.download('flowchart.png', { format: 'png', scale: 2 });
 * ```
 */
export class Export implements Plugin {
    readonly name = 'Export';

    private graph: Graph | null = null;
    private cleanupFns: (() => void)[] = [];

    /**
     * 安装插件
     */
    install(graph: Graph): void {
        this.graph = graph;
    }

    /**
     * 卸载插件
     */
    uninstall(): void {
        this.cleanupFns.forEach((fn) => fn());
        this.cleanupFns = [];
        this.graph = null;
    }

    /**
     * 导出为 PNG 格式
     * @param options - 导出选项
     * @returns PNG 图片的 Data URL
     */
    toPNG(options: Omit<ExportOptions, 'format'> = {}): string {
        return this.export({ ...options, format: 'png' });
    }

    /**
     * 导出为 JPEG 格式
     * @param options - 导出选项
     * @returns JPEG 图片的 Data URL
     */
    toJPEG(options: Omit<ExportOptions, 'format'> = {}): string {
        return this.export({ ...options, format: 'jpeg' });
    }

    /**
     * 导出为 SVG 格式
     * @param options - SVG 导出选项
     * @returns SVG 字符串
     */
    toSVG(options: SVGExportOptions = {}): string {
        if (!this.graph) {
            throw new Error('Export plugin is not installed');
        }

        const canvas = this.graph.getFullCanvas();
        const { width, height, scale = 1, copyStyles = true, extraStyles = '' } = options;

        // 获取画布实际尺寸（getFullCanvas 返回的是世界坐标尺寸，不涉及 DPR）
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;

        // 计算导出尺寸
        const exportWidth = this.parseDimension(width, canvasWidth);
        const exportHeight = this.parseDimension(height, canvasHeight);

        // 创建 SVG 命名空间
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');

        // 设置 SVG 属性 - 未设置时使用 100%
        svg.setAttribute('width', width === undefined ? '100%' : String(exportWidth));
        svg.setAttribute('height', height === undefined ? '100%' : String(exportHeight));
        svg.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`);
        svg.setAttribute('xmlns', svgNS);

        // 收集样式
        let styleContent = '';

        if (copyStyles) {
            styleContent = this.collectExternalStyles();
        }

        if (extraStyles) {
            styleContent += extraStyles;
        }

        // 添加样式到 SVG
        if (styleContent) {
            const style = document.createElementNS(svgNS, 'style');
            style.textContent = styleContent;
            svg.appendChild(style);
        }

        // 创建背景矩形
        const backgroundColor = options.backgroundColor;
        if (backgroundColor) {
            const rect = document.createElementNS(svgNS, 'rect');
            rect.setAttribute('width', '100%');
            rect.setAttribute('height', '100%');
            rect.setAttribute('fill', backgroundColor);
            svg.appendChild(rect);
        }

        // 将 Canvas 内容转换为图片并嵌入 SVG
        const img = document.createElementNS(svgNS, 'image');
        img.setAttribute('width', String(canvasWidth));
        img.setAttribute('height', String(canvasHeight));
        img.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        // 获取 PNG 数据并设置到 image 元素
        const pngDataUrl = this.toPNG({ ...options, scale });
        img.setAttribute('href', pngDataUrl);

        svg.appendChild(img);

        // 序列化为字符串
        const serializer = new XMLSerializer();
        let svgString = serializer.serializeToString(svg);

        // 添加 XML 声明
        svgString = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + svgString;

        return svgString;
    }

    /**
     * 导出为 Blob
     * @param options - 导出选项
     * @returns 包含图片数据的 Blob
     */
    toBlob(options: ExportOptions = {}): Promise<Blob> {
        return new Promise((resolve) => {
            const dataUrl = this.export(options);

            // 对于 SVG 格式，直接创建 Blob
            if (options.format === 'svg') {
                const svgString = this.toSVG(options);
                const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
                resolve(blob);
                return;
            }

            // 对于图片格式，从 Data URL 转换
            const byteString = atob(dataUrl.split(',')[1]);
            const mimeType = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
            const ab = new ArrayBuffer(byteString.length);
            const ia = new Uint8Array(ab);

            for (let i = 0; i < byteString.length; i++) {
                ia[i] = byteString.charCodeAt(i);
            }

            const blob = new Blob([ab], { type: mimeType });
            resolve(blob);
        });
    }

    /**
     * 下载导出的图片
     * @param filename - 文件名
     * @param options - 导出选项
     */
    download(filename?: string, options: ExportOptions = {}): void {
        const format = options.format || 'png';
        const defaultFilename = `export-${Date.now()}.${format}`;
        const finalFilename = filename || defaultFilename;

        let dataUrl: string;

        if (format === 'svg') {
            const svgString = this.toSVG(options);
            dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
        } else {
            dataUrl = this.export(options);
        }

        const link = document.createElement('a');
        link.download = finalFilename;
        link.href = dataUrl;
        link.style.display = 'none';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /**
     * 获取导出的 Data URL
     * @param options - 导出选项
     * @returns 图片的 Data URL
     */
    export(options: ExportOptions = {}): string {
        if (!this.graph) {
            throw new Error('Export plugin is not installed');
        }

        const {
            format = 'png',
            quality = 1,
            width,
            height,
            backgroundColor,
            scale = 1,
            includeGrid = false,
            padding = 0,
        } = options;

        // 获取画布：默认导出整个画布内容，除非指定了 view: true
        const canvas = options.view === true
            ? this.graph.getViewportCanvas()
            : this.graph.getFullCanvas();

        // 获取原始画布尺寸
        const sourceWidth = canvas.width;
        const sourceHeight = canvas.height;

        // 计算导出尺寸
        const targetWidth = Math.round(this.parseDimension(width, sourceWidth) + padding * 2);
        const targetHeight = Math.round(this.parseDimension(height, sourceHeight) + padding * 2);

        // 创建临时画布
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d')!;

        // 设置画布尺寸（考虑用户指定的 scale）
        tempCanvas.width = Math.round(targetWidth * scale);
        tempCanvas.height = Math.round(targetHeight * scale);

        // 应用缩放
        tempCtx.scale(scale, scale);

        // 填充背景
        if (backgroundColor) {
            tempCtx.fillStyle = backgroundColor;
            tempCtx.fillRect(0, 0, targetWidth, targetHeight);
        } else if (format === 'jpeg') {
            // JPEG 不支持透明，默认使用白色背景
            tempCtx.fillStyle = '#ffffff';
            tempCtx.fillRect(0, 0, targetWidth, targetHeight);
        }

        // 如果需要包含网格，先绘制网格
        if (includeGrid) {
            this.drawGrid(tempCtx, targetWidth, targetHeight);
        }

        // 绘制原画布内容（居中）
        const offsetX = padding + (targetWidth - padding * 2 - sourceWidth) / 2;
        const offsetY = padding + (targetHeight - padding * 2 - sourceHeight) / 2;

        tempCtx.drawImage(canvas, offsetX, offsetY);

        // 转换为 Data URL
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        return tempCanvas.toDataURL(mimeType, quality);
    }

    /**
     * 获取画布的边界框（包含所有节点）
     * @param padding - 内边距
     * @returns 边界框信息
     */
    getContentBounds(padding: number = 10): { x: number; y: number; width: number; height: number } | null {
        if (!this.graph) {
            return null;
        }

        // 获取所有节点
        const nodes = this.graph.getAllNodes();
        if (nodes.length === 0) {
            return null;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        nodes.forEach((node) => {
            const bounds = node.getBounds();
            minX = Math.min(minX, bounds.x);
            minY = Math.min(minY, bounds.y);
            maxX = Math.max(maxX, bounds.x + bounds.width);
            maxY = Math.max(maxY, bounds.y + bounds.height);
        });

        return {
            x: minX - padding,
            y: minY - padding,
            width: maxX - minX + padding * 2,
            height: maxY - minY + padding * 2,
        };
    }

    /**
     * 导出特定区域
     * @param bounds - 导出区域 { x, y, width, height }
     * @param options - 导出选项
     * @returns 图片的 Data URL
     */
    exportRegion(
        bounds: { x: number; y: number; width: number; height: number },
        options: Omit<ExportOptions, 'width' | 'height'> = {}
    ): string {
        if (!this.graph) {
            throw new Error('Export plugin is not installed');
        }

        const canvas = this.graph.getFullCanvas();
        const { quality = 1, backgroundColor, scale = 1, format = 'png' } = options;

        // 创建临时画布
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d')!;

        // 设置画布尺寸（考虑缩放）
        tempCanvas.width = bounds.width * scale;
        tempCanvas.height = bounds.height * scale;

        // 应用缩放
        tempCtx.scale(scale, scale);

        // 填充背景
        if (backgroundColor) {
            tempCtx.fillStyle = backgroundColor;
            tempCtx.fillRect(0, 0, bounds.width, bounds.height);
        } else if (format === 'jpeg') {
            tempCtx.fillStyle = '#ffffff';
            tempCtx.fillRect(0, 0, bounds.width, bounds.height);
        }

        // 绘制指定区域
        tempCtx.drawImage(
            canvas,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            0,
            0,
            bounds.width,
            bounds.height
        );

        // 转换为 Data URL
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        return tempCanvas.toDataURL(mimeType, quality);
    }

    /**
     * 解析尺寸值
     * @param value - 尺寸值（数字、字符串或百分比）
     * @param defaultValue - 默认值
     * @returns 解析后的数值
     */
    private parseDimension(value: number | string | undefined, defaultValue: number): number {
        if (value === undefined) {
            return defaultValue;
        }

        if (typeof value === 'number') {
            return value;
        }

        // 处理百分比
        if (typeof value === 'string' && value.endsWith('%')) {
            const percentage = parseFloat(value) / 100;
            return defaultValue * percentage;
        }

        return parseFloat(value) || defaultValue;
    }

    /**
     * 绘制网格背景
     * @param ctx - Canvas 上下文
     * @param width - 宽度
     * @param height - 高度
     */
    private drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
        const gridSize = 20;
        const gridColor = '#e5e7eb';

        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;

        // 绘制垂直线
        for (let x = 0; x <= width; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        // 绘制水平线
        for (let y = 0; y <= height; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
    }

    /**
     * 收集外部样式表中的样式
     * @returns CSS 样式字符串
     */
    private collectExternalStyles(): string {
        let styles = '';

        // 遍历所有样式表
        for (let i = 0; i < document.styleSheets.length; i++) {
            const styleSheet = document.styleSheets[i];

            try {
                const rules = styleSheet.cssRules || styleSheet.rules;
                if (rules) {
                    for (let j = 0; j < rules.length; j++) {
                        styles += rules[j].cssText + '\n';
                    }
                }
            } catch (e) {
                // 跨域样式表无法访问，跳过
                console.warn('Cannot access stylesheet:', styleSheet.href);
            }
        }

        // 添加一些基本的 SVG 样式
        styles += `
            text {
                font-family: system-ui, -apple-system, sans-serif;
            }
        `;

        return styles;
    }
}

export default Export;
