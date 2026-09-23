import {checkHeader, checkLine, type CheckItem} from './types.js';

export class CheckStream {
	private started = false;
	private finished = false;
	private count = 0;
	private failures = 0;
	private warnings = 0;

	public constructor(private readonly title: string, private readonly write: (line: string) => void) {}

	public start(): void {
		if (this.started) return;
		this.started = true;
		this.write(this.title);
		for (const line of checkHeader().split('\n')) this.write(line);
	}

	public row(item: CheckItem): void {
		if (this.finished) return;
		this.start();
		this.write(checkLine(item));
		this.count++;
		if (item.state === 'FAIL') this.failures++;
		if (item.state === 'WARN') this.warnings++;
	}

	public finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.start();
		this.write(`检查完成：${this.count} 项，${this.failures} FAIL，${this.warnings} WARN`);
	}
}
