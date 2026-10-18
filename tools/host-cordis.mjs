// Read the installed host's runtime without changing its installation.
import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function hostCordis() {
  const archive = [process.env.DSH_APP_ASAR,
    join(homedir(), 'AppData/Local/Programs/DeepSeek Harness/resources/app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  ].filter(Boolean).find(existsSync);
  if (!archive) return null;
  const fd = openSync(archive, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    const tree = JSON.parse(json.toString());
    const start = 8 + head.readUInt32LE(4);
    const read = name => {
      let entry = tree;
      for (const part of name.split('/')) entry = entry.files[part];
      const data = Buffer.alloc(entry.size);
      readSync(fd, data, 0, data.length, start + Number(entry.offset));
      return data.toString();
    };
    const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    const cosmokit = dataUrl(read('node_modules/@deepseek-ai/cosmokit/lib/index.js'));
    const cordis = read('node_modules/@deepseek-ai/cordis/lib/index.js')
      .replace('"@deepseek-ai/cosmokit"', JSON.stringify(cosmokit));
    return await import(dataUrl(cordis));
  } finally { closeSync(fd); }
}
