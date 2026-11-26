// Prints the script a corpus entry converts to, for reading by eye.
declare const process: { argv: string[] };

import { convertPine } from '../src/indicators/pine/emit';
import { CORPUS } from './pine-corpus';

for (const id of process.argv.slice(2)) {
  const script = CORPUS.find((entry) => entry.id === id);
  if (!script) {
    console.log(`missing ${id}`);
    continue;
  }
  const result = convertPine(script.pine);
  console.log(`===== ${id} ok=${result.ok} name="${result.name}"`);
  console.log(result.source || result.errors.map((error) => `line ${error.line}: ${error.message}`).join('\n'));
}
