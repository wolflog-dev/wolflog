// Conventions de l'interface : un composant / directive / pipe / service (ou une classe) par fichier,
// noms de fichiers en kebab-case. Lancé par `npm run check` et en CI.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../src/app/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) files.push(path);
  }
};
walk(root);

const problems = [];
for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const source = readFileSync(file, 'utf8');
  const classes = [...source.matchAll(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm)].map((m) => m[1]);
  if (classes.length > 1) problems.push(`${rel} : plusieurs classes (${classes.join(', ')})`);
  const name = rel.split('/').pop().replace(/\.ts$/, '');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/.test(name)) problems.push(`${rel} : nom de fichier attendu en kebab-case`);
}

if (problems.length) {
  console.error(`Conventions non respectées :\n${problems.map((p) => '  ' + p).join('\n')}`);
  process.exit(1);
}
console.log(`Structure OK (${files.length} fichiers).`);
