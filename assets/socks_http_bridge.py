#!/usr/bin/env python3
"""Loopback HTTP proxy backed by a SOCKS5 gateway from a mode-0600 config file."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import select
import signal
import socket
import sys
import threading
from urllib.parse import unquote, urlsplit


HOP_BY_HOP = {b"proxy-connection", b"proxy-authorization", b"connection", b"keep-alive"}


def read_config(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def socks5_connect(host: str, port: int, config_path: Path) -> socket.socket:
    proxy = read_config(config_path).get("SOCKS5_PROXY", "")
    parsed = urlsplit(proxy)
    if parsed.scheme not in {"socks5", "socks5h"} or not parsed.hostname or not parsed.port:
        raise ValueError("SOCKS5_PROXY must be a valid socks5h:// URL")

    upstream = socket.create_connection((parsed.hostname, parsed.port), timeout=20)
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    if username or password:
        user_bytes, password_bytes = username.encode(), password.encode()
        if len(user_bytes) > 255 or len(password_bytes) > 255:
            raise ValueError("SOCKS5 username or password is too long")
        upstream.sendall(b"\x05\x01\x02")
        if upstream.recv(2) != b"\x05\x02":
            raise OSError("SOCKS5 username/password authentication is unavailable")
        upstream.sendall(
            bytes((1, len(user_bytes)))
            + user_bytes
            + bytes((len(password_bytes),))
            + password_bytes
        )
        if upstream.recv(2) != b"\x01\x00":
            raise OSError("SOCKS5 credentials were rejected")
    else:
        upstream.sendall(b"\x05\x01\x00")
        if upstream.recv(2) != b"\x05\x00":
            raise OSError("SOCKS5 no-auth negotiation failed")

    host_bytes = host.encode("idna")
    if len(host_bytes) > 255:
        raise ValueError("target hostname is too long")
    upstream.sendall(
        b"\x05\x01\x00\x03" + bytes((len(host_bytes),)) + host_bytes + port.to_bytes(2, "big")
    )
    response = recv_exact(upstream, 4)
    if response[1] != 0:
        raise OSError(f"SOCKS5 CONNECT failed with status {response[1]}")
    address_type = response[3]
    if address_type == 1:
        size = 4
    elif address_type == 3:
        size = recv_exact(upstream, 1)[0]
    elif address_type == 4:
        size = 16
    else:
        raise OSError("SOCKS5 returned an unsupported address type")
    recv_exact(upstream, size + 2)
    upstream.settimeout(None)
    return upstream


def recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise OSError("unexpected EOF")
        chunks.extend(chunk)
    return bytes(chunks)


def relay(left: socket.socket, right: socket.socket) -> None:
    sockets = [left, right]
    while True:
        readable, _, _ = select.select(sockets, [], [], 180)
        if not readable:
            return
        for source in readable:
            target = right if source is left else left
            data = source.recv(65536)
            if not data:
                return
            target.sendall(data)


def fail(client: socket.socket, code: int, reason: str) -> None:
    try:
        client.sendall(
            f"HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode()
        )
    except OSError:
        pass


def origin_request(parts: list[str], headers: bytes) -> tuple[str, int, bytes]:
    parsed = urlsplit(parts[1])
    if parsed.scheme != "http" or not parsed.hostname:
        raise ValueError("only absolute http:// requests are supported")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    lines = [f"{parts[0]} {path} {parts[2]}".encode("latin1")]
    has_host = False
    for line in headers.split(b"\r\n"):
        if not line:
            continue
        name = line.partition(b":")[0].strip().lower()
        if name in HOP_BY_HOP:
            continue
        has_host = has_host or name == b"host"
        lines.append(line)
    if not has_host:
        suffix = f":{parsed.port}" if parsed.port else ""
        lines.append(f"Host: {parsed.hostname}{suffix}".encode("latin1"))
    lines.append(b"Connection: close")
    return parsed.hostname, parsed.port or 80, b"\r\n".join(lines) + b"\r\n\r\n"


def handle(client: socket.socket, config_path: Path) -> None:
    upstream: socket.socket | None = None
    try:
        client.settimeout(20)
        data = bytearray()
        while b"\r\n\r\n" not in data and len(data) < 65536:
            chunk = client.recv(4096)
            if not chunk:
                return
            data.extend(chunk)
        head, separator, body = bytes(data).partition(b"\r\n\r\n")
        first_line, _, headers = head.partition(b"\r\n")
        parts = first_line.decode("latin1").split()
        if not separator or len(parts) != 3:
            fail(client, 400, "Bad Request")
            return
        if parts[0].upper() == "CONNECT":
            host, separator, port_text = parts[1].rpartition(":")
            if not separator or not host:
                fail(client, 400, "Bad Request")
                return
            upstream = socks5_connect(host.strip("[]"), int(port_text), config_path)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        else:
            host, port, request = origin_request(parts, headers)
            upstream = socks5_connect(host, port, config_path)
            upstream.sendall(request + body)
        client.settimeout(None)
        relay(client, upstream)
    except Exception:
        fail(client, 502, "Bad Gateway")
    finally:
        client.close()
        if upstream is not None:
            upstream.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--pid-file", required=True, type=Path)
    args = parser.parse_args()

    args.pid_file.parent.mkdir(parents=True, exist_ok=True)
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", args.port))
    listener.listen(64)
    args.pid_file.write_text(f"{os.getpid()}\n", encoding="ascii")
    os.chmod(args.pid_file, 0o600)

    stopping = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
        stopping.set()
        listener.close()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping.is_set():
            try:
                client, _ = listener.accept()
            except OSError:
                break
            threading.Thread(target=handle, args=(client, args.config), daemon=True).start()
    finally:
        try:
            if args.pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
                args.pid_file.unlink(missing_ok=True)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

