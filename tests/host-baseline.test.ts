import assert from 'node:assert/strict';
import test from 'node:test';
import {compareMachineFacts, imageRecipeForHost, parseOsRelease, type MachineFacts} from '../src/host-baseline.js';

test('base image follows the host OS and unknown hosts still get a reported fallback', () => {
	const ubuntu = parseOsRelease('PRETTY_NAME="Ubuntu 24.04.4 LTS"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n');
	assert.match(imageRecipeForHost(ubuntu).baseImage, /^ubuntu:24\.04@sha256:/);
	const debian = parseOsRelease('PRETTY_NAME="Debian GNU/Linux 12"\nVERSION_ID="12"\nID=debian\n');
	assert.equal(imageRecipeForHost(debian).baseImage, 'debian:12-slim');
	const unknown = parseOsRelease('PRETTY_NAME="Custom Linux"\nVERSION_ID="1"\nID=custom\n');
	assert.match(imageRecipeForHost(unknown).note || '', /Custom Linux/);
});

test('host and image facts show version drift and block architecture mismatches', () => {
	const os = parseOsRelease('PRETTY_NAME="Ubuntu 24.04.4 LTS"\nVERSION_ID="24.04"\nID=ubuntu\n');
	const host: MachineFacts = {os, arch: 'x64', kernel: '6.8', uid: 1000, gid: 1001, node: 'v24.20.0', python: 'Python 3.12.3', git: 'git version 2.43.0', bubblewrap: '', bubblewrapReady: false};
	const image: MachineFacts = {...host, os: {...os, prettyName: 'Ubuntu 24.04.5 LTS'}, node: 'v24.21.0', bubblewrap: 'bubblewrap 0.8.0'};
	const rows = compareMachineFacts(host, image);
	assert.equal(rows.find(row => row.name === '发行版')?.state, 'PASS');
	assert.equal(rows.find(row => row.name === '发行版补丁')?.state, 'WARN');
	assert.equal(rows.find(row => row.name === 'Node')?.state, 'WARN');
	assert.equal(rows.find(row => row.name === 'bubblewrap')?.state, 'PASS');
	assert.equal(rows.find(row => row.name === '内层用户命名空间')?.state, 'WARN');
	assert.equal(compareMachineFacts(host, {...image, arch: 'arm64'}).find(row => row.name === 'CPU 架构')?.state, 'FAIL');
});
