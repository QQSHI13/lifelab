// Life pattern verifier — steps a pattern under a B/S rule and reports what it
// actually does, so a pattern's claimed behaviour can be checked instead of trusted.
//
// usage: node tools/verify-patterns.mjs   (verifies patterns/*.json in the repo)
// Each pattern declares the behaviour it is supposed to have in an `expect`
// block; a pattern without one fails, so the library cannot silently rot.
//
// The default export-free design keeps this runnable by plain `node` in CI.

export function parseRule(str) {
  const m = String(str).match(/B([0-9]*)\/S([0-9]*)/i);
  if (!m) throw new Error(`bad rule: ${str}`);
  return {
    born: new Set((m[1] || '').split('').map(Number)),
    survive: new Set((m[2] || '').split('').map(Number)),
  };
}

export function parseRLE(text) {
  const lines = String(text).trim().split('\n');
  let width = 0, height = 0, rule = 'B3/S23', start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^x\s*=/.test(line)) {
      width = parseInt((line.match(/x\s*=\s*(\d+)/i) || [0, 0])[1], 10);
      height = parseInt((line.match(/y\s*=\s*(\d+)/i) || [0, 0])[1], 10);
      const r = line.match(/rule\s*=\s*([Bb][0-9]*\/[Ss][0-9]*)/);
      if (r) rule = r[1].toUpperCase();
      start = i + 1;
      break;
    }
  }
  const data = lines.slice(start).join('').replace(/\s/g, '').split('!')[0];
  const cells = [];
  let x = 0, y = 0, i = 0;
  while (i < data.length) {
    let n = 0;
    while (i < data.length && data[i] >= '0' && data[i] <= '9') n = n * 10 + Number(data[i++]);
    if (n === 0) n = 1;
    const ch = data[i];
    if (ch === 'b' || ch === '.') x += n;
    else if (ch === 'o' || ch === 'O' || ch === '*') { for (let k = 0; k < n; k++) cells.push([x + k, y]); x += n; }
    else if (ch === '$') { y += n; x = 0; }
    else if (ch === undefined) break;
    else throw new Error(`bad RLE char '${ch}' at ${i}`);
    i++;
  }
  return { width, height, rule, cells };
}

export function step(rule, cells) {
  const count = new Map();
  for (const [x, y] of cells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const k = `${x + dx},${y + dy}`;
        count.set(k, (count.get(k) || 0) + 1);
      }
    }
  }
  for (const [x, y] of cells) {
    const k = `${x},${y}`;
    if (!count.has(k)) count.set(k, 0);
  }
  const alive = new Set(cells.map(([x, y]) => `${x},${y}`));
  const out = [];
  for (const [k, n] of count) {
    const isAlive = alive.has(k);
    if (isAlive ? rule.survive.has(n) : rule.born.has(n)) {
      const c = k.indexOf(',');
      out.push([+k.slice(0, c), +k.slice(c + 1)]);
    }
  }
  return out;
}

const sig = (cells) => {
  if (!cells.length) return { s: '', mnx: 0, mny: 0, w: 0, h: 0 };
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of cells) {
    if (x < mnx) mnx = x; if (y < mny) mny = y;
    if (x > mxx) mxx = x; if (y > mxy) mxy = y;
  }
  return { s: cells.map(([x, y]) => `${x - mnx},${y - mny}`).sort().join(' '), mnx, mny, w: mxx - mnx + 1, h: mxy - mny + 1 };
};

/** Run a pattern and describe what it does. */
export function classify(cells, ruleStr, maxGen = 5206, maxPop = 60000) {
  const rule = parseRule(ruleStr);
  const seen = new Map();
  let cur = cells.map(c => [...c]);
  const pops = [cur.length];
  for (let g = 1; g <= maxGen; g++) {
    cur = step(rule, cur);
    pops.push(cur.length);
    if (cur.length === 0) return { kind: 'dies', gen: g };
    // explosive rules (Seeds) or replicators blow up exponentially — stop early
    if (cur.length > maxPop) {
      return { kind: 'growth', pop: cur.length, growth: cur.length - pops[Math.max(0, pops.length - 51)], gen: g, exploded: true };
    }
    if (g <= 120) {
      const { s, mnx, mny } = sig(cur);
      if (seen.has(s)) {
        const prev = seen.get(s);
        const dx = mnx - prev.mnx, dy = mny - prev.mny;
        const period = g - prev.g;
        if (dx || dy) return { kind: 'spaceship', period, dx, dy, pop: cur.length };
        // a pattern that repeats itself in place every generation is a still
        // life, not a period-1 oscillator
        if (period === 1) return { kind: 'stable', gen: prev.g, pop: cur.length };
        return { kind: 'oscillator', period, pop: cur.length };
      }
      seen.set(s, { g, mnx, mny });
    }
    if (g > 80) {
      const t = pops.slice(-30);
      if (t.length === 30 && t.every(v => v === t[0])) return { kind: 'stable', gen: g - 29, pop: cur.length };
    }
  }
  const a = pops[pops.length - 101], b = pops[pops.length - 1];
  return b > a ? { kind: 'growth', pop: b, growth: b - a, gen: maxGen }
               : { kind: 'unstable', pop: b, gen: maxGen };
}

export function describe(r) {
  switch (r.kind) {
    case 'oscillator': return `oscillator period ${r.period}`;
    case 'spaceship': return `spaceship period ${r.period}, moves (${r.dx},${r.dy})`;
    case 'stable': return `stable, ${r.pop} cells at gen ${r.gen}`;
    case 'dies': return `dies at gen ${r.gen}`;
    case 'growth': return `unbounded growth, ${r.pop} cells by gen ${r.gen}`;
    case 'unstable': return `unstable, ${r.pop} cells`;
    default: return r.kind;
  }
}

/** Does `r` satisfy the pattern's `expect` block? */
export function matches(r, expect) {
  if (!expect) return { ok: true, why: '' };
  if (expect.kind && r.kind !== expect.kind) return { ok: false, why: `expected ${expect.kind}, got ${r.kind}` };
  if (expect.period && r.period !== expect.period) return { ok: false, why: `expected period ${expect.period}, got ${r.period}` };
  if (expect.dx !== undefined && r.dx !== expect.dx) return { ok: false, why: `expected dx ${expect.dx}, got ${r.dx}` };
  if (expect.dy !== undefined && r.dy !== expect.dy) return { ok: false, why: `expected dy ${expect.dy}, got ${r.dy}` };
  if (expect.popMin !== undefined && r.pop < expect.popMin) return { ok: false, why: `expected pop >= ${expect.popMin}, got ${r.pop}` };
  if (expect.popMax !== undefined && r.pop > expect.popMax) return { ok: false, why: `expected pop <= ${expect.popMax}, got ${r.pop}` };
  if (expect.pop !== undefined && expect.popMin === undefined && expect.popMax === undefined && r.pop !== expect.pop) {
    return { ok: false, why: `expected pop ${expect.pop}, got ${r.pop}` };
  }
  if (expect.gen !== undefined && r.gen !== expect.gen) return { ok: false, why: `expected gen ${expect.gen}, got ${r.gen}` };
  if (expect.genMin && r.gen < expect.genMin) return { ok: false, why: `expected gen >= ${expect.genMin}, got ${r.gen}` };
  return { ok: true, why: '' };
}

// ---- CLI: verify every patterns/*.json next to this script ----
if (process.argv[1] && process.argv[1].endsWith('verify-patterns.mjs')) {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'patterns');

  let total = 0, bad = 0;
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'schema.json').sort()) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    console.log(`\n== ${f} (category ${data.category}) ==`);
    for (const p of data.patterns || []) {
      total++;
      const rule = Array.isArray(p.rule) ? p.rule[0] : (p.rule || 'B3/S23');
      const r = classify(p.cells, rule, p.expect && p.expect.genMin ? 6000 : 1300);
      const { ok, why } = matches(r, p.expect);
      // every pattern must declare what it is supposed to do, or this can rot again
      const declared = p.expect ? ok : false;
      if (!declared) bad++;
      const note = p.expect ? why : 'no expect block';
      console.log(`  ${declared ? 'ok  ' : 'FAIL'} ${String(p.name).padEnd(20)} ${describe(r).padEnd(42)} ${declared ? '' : note}`);
    }
  }
  console.log(`\n${total - bad}/${total} patterns match their declared behaviour`);
  process.exit(bad ? 1 : 0);
}
