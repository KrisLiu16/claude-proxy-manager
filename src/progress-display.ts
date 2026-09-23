export type CheckProgress = {percent: number; label: string};

function clip(value: string, columns: number): string {
	let width = 0;
	let result = '';
	for (const char of value) {
		const size = /[^\u0000-\u00ff]/.test(char) ? 2 : 1;
		if (width + size > columns) break;
		result += char;
		width += size;
	}
	return result;
}

export class TerminalProgress {
	private readonly started = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;
	private current: CheckProgress = {percent: 0, label: '准备中'};
	private previousStage = '';
	private lastHeartbeat = 0;
	private drew = false;
	private finished = false;

	public constructor(private readonly title: string, private readonly stream: NodeJS.WriteStream = process.stderr) {}

	public update(progress: CheckProgress): void {
		if (this.finished) return;
		this.current = progress;
		if (!this.timer) {
			this.timer = setInterval(() => this.draw(), 1_000);
			this.timer.unref();
		}
		this.draw();
	}

	private draw(): void {
		if (this.finished) return;
		const elapsed = Math.floor((Date.now() - this.started) / 1_000);
		const line = `${this.title} [${String(Math.round(this.current.percent)).padStart(3)}%] ${this.current.label} · ${elapsed}s`;
		if (this.stream.isTTY) {
			const width = Math.max(20, (this.stream.columns || 80) - 2);
			this.stream.write(`\r\x1b[2K${clip(line, width)}`);
		} else {
			const stage = `${this.current.percent}:${this.current.label}`;
			const heartbeat = elapsed > 0 && elapsed % 5 === 0 && elapsed !== this.lastHeartbeat;
			if (stage !== this.previousStage || heartbeat) this.stream.write(`${line}\n`);
			this.previousStage = stage;
			if (heartbeat) this.lastHeartbeat = elapsed;
		}
		this.drew = true;
	}

	public line(value: string): void {
		if (this.stream.isTTY && this.drew && !this.finished) this.stream.write('\r\x1b[2K');
		this.stream.write(`${value}\n`);
		if (this.stream.isTTY && this.drew && !this.finished) this.draw();
	}

	public finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.timer) clearInterval(this.timer);
		if (this.stream.isTTY && this.drew) this.stream.write('\r\x1b[2K');
	}
}
