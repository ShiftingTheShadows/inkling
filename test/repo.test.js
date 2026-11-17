// F43: the deploy comments must name the host this project actually deploys to.
// Vercel (vercel.json + .github/workflows/web.yml) builds `npm run build` into
// dist/, so build.mjs and the call-site comments should say so — an old Netlify
// reference sends anyone debugging a deploy to the wrong dashboard.
import fs from 'node:fs';
import { makeRunner } from './harness.js';

const { eq, ok, done } = makeRunner();
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const build = read('build.mjs');
const utils = read('src/hmm-utils.jsx');
const vercel = JSON.parse(read('vercel.json'));

ok('the deploy target is Vercel', vercel.buildCommand === 'npm run build' && vercel.outputDirectory === 'dist');

ok('build.mjs does not claim Netlify publishes dist/', !/netlify/i.test(build));
ok('build.mjs names the host it actually deploys to', /vercel/i.test(build));
eq('build.mjs documents the production output', /production version to dist\/|writes[\s\S]{0,40}dist\//.test(build), true);

ok('no source comment claims a Netlify function hosts the API', !/netlify/i.test(utils));
ok('the API comment names the same host as the deploy', /api\/anthropic|vercel/i.test(utils));

done();
