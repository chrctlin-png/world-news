// scripts/refresh-news.mjs
//
// FREE VERSION — no API key required.
// Pulls 2-3 real, current headlines per topic from Google News RSS
// (https://news.google.com/rss/search), then writes them into index.html's
// DATA object. Headlines link back to the original source article.
//
// The GitHub Actions workflow runs this on a daily schedule and commits
// the change automatically.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'index.html');

// id MUST match the keys used in index.html's TOPICS/DATA arrays.
const TOPICS = [
  { id: 'us', query: 'US national news' },
  { id: 'tw', query: 'Taiwan news' },
  { id: 'cn', query: 'China news' },
  { id: 'mx', query: 'Mexico news' },
  { id: 'in', query: 'India news' },
  { id: 'ca', query: 'Canada news' },
  { id: 'cl', query: 'Chile news' },
  { id: 'wmt', query: 'Walmart' },
  { id: 'ai', query: 'artificial intelligence industry' },
  { id: 'agent', query: 'AI agents' },
  { id: 'tech', query: 'technology industry' },
  { id: 'retail', query: 'retail sector' },
  { id: 'wc', query: 'World Cup 2026' },
  { id: 'tsla', query: 'Tesla' },
  { id: 'spacex', query: 'SpaceX' },
  { id: 'geo', query: 'geopolitics world news' },
  { id: 'uk', query: 'UK news' },
  { id: 'eu', query: 'Europe EU news' },
  { id: 'anthropic', query: 'Anthropic AI' },
  { id: 'openai', query: 'OpenAI' },
  { id: 'amazon', query: 'Amazon company' },
  { id: 'nvidia', query: 'Nvidia' },
  { id: 'tsmc', query: 'TSMC' },
  { id: 'google', query: 'Google Gemini Alphabet' },
  { id: 'movie', query: 'movie box office' },
  { id: 'sports', query: 'sports news' },
  { id: 'book', query: 'book publishing' },
  { id: 'music', query: 'music industry' },
];

const ITEMS_PER_TOPIC = 3;

function decodeEntities(str) {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, '') // strip any leftover HTML tags
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) val = cdata[1];
  return decodeEntities(val);
}

function extractSourceAttr(block) {
  const m = block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
  return m ? decodeEntities(m[1]) : '';
}

async function fetchTopic(topic) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic.query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
  });

  if (!res.ok) {
    console.error(`Fetch failed for "${topic.id}": ${res.status}`);
    return null;
  }

  const xml = await res.text();
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (itemBlocks.length === 0) {
    console.error(`No items found for "${topic.id}"`);
    return null;
  }

  const results = [];
  for (const block of itemBlocks.slice(0, ITEMS_PER_TOPIC)) {
    let title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    let source = extractSourceAttr(block);
    const pubDate = extractTag(block, 'pubDate');

    // Google News titles are usually "Headline - Source Name"; strip the
    // trailing source if we already have it from the <source> tag.
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim();
    }
    if (!source) {
      const dash = title.lastIndexOf(' - ');
      if (dash !== -1) {
        source = title.slice(dash + 3).trim();
        title = title.slice(0, dash).trim();
      } else {
        source = 'Google News';
      }
    }

    let dateLabel = '';
    if (pubDate) {
      const d = new Date(pubDate);
      if (!isNaN(d)) {
        dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    }

    if (title && link) {
      results.push({
        title,
        summary: dateLabel ? `Reported ${dateLabel}. Tap to read the full story.` : 'Tap to read the full story.',
        source,
        url: link,
      });
    }
  }

  return results.length > 0 ? results : null;
}

function escapeForJs(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ').trim();
}

function buildDataBlock(allTopics, results) {
  const lines = ['const DATA = {'];
  for (const topic of allTopics) {
    const items = results[topic.id] || [];
    lines.push(`  ${topic.id}: [`);
    for (const item of items) {
      const urlPart = item.url ? `, url: '${escapeForJs(item.url)}'` : '';
      lines.push(
        `    { title: '${escapeForJs(item.title)}', summary: '${escapeForJs(item.summary)}', source: '${escapeForJs(item.source)}'${urlPart} },`
      );
    }
    lines.push('  ],');
  }
  lines.push('};');
  return lines.join('\n');
}

async function main() {
  let html = await fs.readFile(INDEX_PATH, 'utf8');

  const existingMatch = html.match(/const DATA = \{[\s\S]*?\n\};/);
  if (!existingMatch) throw new Error('Could not find "const DATA = {...};" block in index.html');

  // Parse existing DATA so a topic that fails today keeps yesterday's content
  // instead of going blank.
  let existingData = {};
  try {
    const fn = new Function(`${existingMatch[0]}\nreturn DATA;`);
    existingData = fn();
  } catch (e) {
    console.warn('Could not parse existing DATA block, continuing with fresh results only.');
  }

  const freshResults = {};
  for (const topic of TOPICS) {
    console.log(`Fetching: ${topic.id} ...`);
    const items = await fetchTopic(topic);
    if (items) {
      freshResults[topic.id] = items;
      console.log(`  -> ${items.length} item(s)`);
    } else {
      console.warn(`  -> no fresh data, keeping previous content for "${topic.id}"`);
    }
    await new Promise((r) => setTimeout(r, 300)); // be polite to the feed
  }

  const merged = {};
  for (const topic of TOPICS) {
    merged[topic.id] = freshResults[topic.id] || existingData[topic.id] || [];
  }

  const newBlock = buildDataBlock(TOPICS, merged);
  html = html.replace(/const DATA = \{[\s\S]*?\n\};/, newBlock);

  const stamp = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  html = html.replace(
    /<!-- LAST_REFRESHED -->[\s\S]*?<!-- \/LAST_REFRESHED -->/,
    `<!-- LAST_REFRESHED -->Last refreshed: <b>${stamp} (Asia/Taipei)</b><!-- /LAST_REFRESHED -->`
  );

  await fs.writeFile(INDEX_PATH, html, 'utf8');
  console.log('index.html updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
