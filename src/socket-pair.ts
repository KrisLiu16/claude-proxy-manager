import type {Socket} from 'node:net';

// Both peers may close while data is already queued by pipe(). Bun emits
// ERR_SOCKET_CLOSED for that write, so detach both pipes before destroying.
export function pipeSockets(left: Socket, right: Socket): void {
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		left.unpipe(right);
		right.unpipe(left);
		left.destroy();
		right.destroy();
	};
	left.on('error', close);
	right.on('error', close);
	left.on('close', close);
	right.on('close', close);
	if (left.destroyed || right.destroyed) { close(); return; }
	left.pipe(right).pipe(left);
}
