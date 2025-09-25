import * as path from 'path';
import * as glob from 'glob';
import Mocha = require('mocha');

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    reporter: process.env.MOCHA_REPORTER || 'spec',
    reporterOptions: process.env.MOCHA_REPORTER_OPTIONS ? JSON.parse(process.env.MOCHA_REPORTER_OPTIONS) : undefined,
    timeout: 20000
  });
  const testsRoot = path.resolve(__dirname);
  return new Promise((resolve, reject) => {
    const files: string[] = glob.sync('**/*.test.js', { cwd: testsRoot });
    files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));
    try { mocha.run((failures: number) => failures ? reject(new Error(`${failures} tests failed`)) : resolve()); } catch (e) { reject(e); }
  });
}