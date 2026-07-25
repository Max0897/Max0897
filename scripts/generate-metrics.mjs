import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const token = process.env.GITHUB_TOKEN;
const login = process.env.GITHUB_USER || process.env.GITHUB_REPOSITORY_OWNER || 'Max0897';

if (!token) {
  throw new Error('GITHUB_TOKEN is required');
}

const query = `
  query ProfileMetrics($login: String!, $cursor: String) {
    user(login: $login) {
      followers {
        totalCount
      }
      repositories(
        first: 100
        after: $cursor
        ownerAffiliations: OWNER
        privacy: PUBLIC
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

const themes = {
  light: {
    background: '#ffffff',
    border: '#d0d7de',
    text: '#1f2328',
    muted: '#656d76',
    accent: '#0969da',
    empty: '#ebedf0',
    contributions: ['#9be9a8', '#40c463', '#30a14e', '#216e39'],
  },
  dark: {
    background: '#0d1117',
    border: '#30363d',
    text: '#f0f6fc',
    muted: '#8b949e',
    accent: '#58a6ff',
    empty: '#21262d',
    contributions: ['#0e4429', '#006d32', '#26a641', '#39d353'],
  },
};

async function requestMetrics(cursor) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-metrics-generator',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables: { login, cursor } }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map(({ message }) => message).join('; '));
  }

  if (!payload.data?.user) {
    throw new Error(`GitHub user ${login} was not found`);
  }

  return payload.data.user;
}

async function loadMetrics() {
  let cursor = null;
  let profile = null;
  const repositories = [];

  do {
    const page = await requestMetrics(cursor);
    profile ||= page;
    repositories.push(...page.repositories.nodes);
    cursor = page.repositories.pageInfo.hasNextPage
      ? page.repositories.pageInfo.endCursor
      : null;
  } while (cursor);

  const languages = new Map();
  let stars = 0;

  for (const repository of repositories) {
    stars += repository.stargazerCount;
    for (const { size, node } of repository.languages.edges) {
      const previous = languages.get(node.name) || { name: node.name, color: node.color, size: 0 };
      previous.size += size;
      previous.color ||= node.color;
      languages.set(node.name, previous);
    }
  }

  const sortedLanguages = [...languages.values()].sort((a, b) => b.size - a.size);
  const primaryLanguages = sortedLanguages.slice(0, 5);
  const remainingSize = sortedLanguages.slice(5).reduce((sum, language) => sum + language.size, 0);
  if (remainingSize > 0) {
    primaryLanguages.push({ name: '其他', color: null, size: remainingSize });
  }

  return {
    contributions: profile.contributionsCollection.contributionCalendar,
    followers: profile.followers.totalCount,
    languages: primaryLanguages,
    repositories: profile.repositories.totalCount,
    stars,
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function contributionColor(count, max, theme) {
  if (count === 0 || max === 0) return theme.empty;
  const intensity = Math.min(
    theme.contributions.length,
    Math.max(1, Math.ceil((Math.log(count + 1) / Math.log(max + 1)) * theme.contributions.length)),
  );
  return theme.contributions[intensity - 1];
}

function renderSvg(metrics, themeName) {
  const theme = themes[themeName];
  const width = 900;
  const height = 478;
  const stats = [
    ['公开仓库', metrics.repositories],
    ['累计获赞', metrics.stars],
    ['关注者', metrics.followers],
    ['年度贡献', metrics.contributions.totalContributions],
  ];

  const totalLanguageSize = metrics.languages.reduce((sum, language) => sum + language.size, 0);
  let languageOffset = 40;
  const languageBarWidth = 820;
  const languageBar = metrics.languages.map((language, index) => {
    const remainingWidth = 40 + languageBarWidth - languageOffset;
    const segmentWidth = index === metrics.languages.length - 1
      ? remainingWidth
      : (language.size / totalLanguageSize) * languageBarWidth;
    const markup = `<rect x="${languageOffset.toFixed(2)}" y="218" width="${segmentWidth.toFixed(2)}" height="12" fill="${language.color || theme.muted}" />`;
    languageOffset += segmentWidth;
    return markup;
  }).join('\n');

  const languageLegend = metrics.languages.map((language, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 40 + column * 273;
    const y = 263 + row * 28;
    const percentage = totalLanguageSize === 0 ? 0 : (language.size / totalLanguageSize) * 100;
    const percentageLabel = percentage < 1 ? '&lt;1%' : `${Math.round(percentage)}%`;
    return [
      `<circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${language.color || theme.muted}" />`,
      `<text x="${x + 18}" y="${y}" class="legend">${escapeXml(language.name)} · ${percentageLabel}</text>`,
    ].join('\n');
  }).join('\n');

  const weeks = metrics.contributions.weeks.slice(-52);
  const allDays = weeks.flatMap(({ contributionDays }) => contributionDays);
  const maxContribution = Math.max(0, ...allDays.map(({ contributionCount }) => contributionCount));
  const calendarX = 166;
  const calendarY = 374;
  const cellSize = 10;
  const cellPitch = 13;
  const calendarCells = weeks.flatMap(({ contributionDays }, weekIndex) => (
    contributionDays.map((day) => {
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const x = calendarX + weekIndex * cellPitch;
      const y = calendarY + weekday * cellPitch;
      const color = contributionColor(day.contributionCount, maxContribution, theme);
      return `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${color}"><title>${escapeXml(day.date)}：${day.contributionCount} 次贡献</title></rect>`;
    })
  )).join('\n');

  const monthLabels = [];
  let previousMonth = null;
  let previousLabelX = -Infinity;
  weeks.forEach(({ contributionDays }, weekIndex) => {
    const firstDay = contributionDays[0];
    if (!firstDay) return;
    const month = new Date(`${firstDay.date}T00:00:00Z`).getUTCMonth() + 1;
    const x = calendarX + weekIndex * cellPitch;
    if (month !== previousMonth && x - previousLabelX >= 42) {
      monthLabels.push(`<text x="${x}" y="360" class="calendar-label">${month}月</text>`);
      previousLabelX = x;
    }
    previousMonth = month;
  });

  const statMarkup = stats.map(([label, value], index) => {
    const x = 55 + index * 210;
    return [
      `<text x="${x}" y="106" class="stat-value">${formatNumber(value)}</text>`,
      `<text x="${x}" y="132" class="stat-label">${label}</text>`,
    ].join('\n');
  }).join('\n');

  const separators = [235, 445, 655]
    .map((x) => `<line x1="${x}" y1="84" x2="${x}" y2="136" stroke="${theme.border}" />`)
    .join('\n');

  const updatedAt = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date());

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="478" viewBox="0 0 900 478" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(login)} 的 GitHub 开发数据</title>
  <desc id="description">公开仓库、获赞、关注者、年度贡献、语言占比和贡献日历</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
    .heading { fill: ${theme.text}; font-size: 22px; font-weight: 600; }
    .updated { fill: ${theme.muted}; font-size: 12px; }
    .stat-value { fill: ${theme.accent}; font-size: 28px; font-weight: 600; }
    .stat-label { fill: ${theme.muted}; font-size: 13px; }
    .section-title { fill: ${theme.text}; font-size: 15px; font-weight: 600; }
    .legend { fill: ${theme.muted}; font-size: 12px; }
    .calendar-label { fill: ${theme.muted}; font-size: 11px; }
  </style>
  <rect x="0.5" y="0.5" width="899" height="477" rx="6" fill="${theme.background}" stroke="${theme.border}" />
  <text x="40" y="45" class="heading">开发数据</text>
  <text x="860" y="43" text-anchor="end" class="updated">每日自动更新 · ${escapeXml(updatedAt)}</text>
  ${statMarkup}
  ${separators}
  <line x1="40" y1="164" x2="860" y2="164" stroke="${theme.border}" />
  <text x="40" y="198" class="section-title">语言分布</text>
  <clipPath id="language-bar"><rect x="40" y="218" width="820" height="12" rx="6" /></clipPath>
  <g clip-path="url(#language-bar)">${languageBar}</g>
  ${languageLegend}
  <line x1="40" y1="316" x2="860" y2="316" stroke="${theme.border}" />
  <text x="40" y="346" class="section-title">贡献日历</text>
  <text x="40" y="387" class="calendar-label">周一</text>
  <text x="40" y="413" class="calendar-label">周三</text>
  <text x="40" y="439" class="calendar-label">周五</text>
  ${monthLabels.join('\n')}
  ${calendarCells}
</svg>
`;
}

function renderMobileSvg(metrics, themeName) {
  const theme = themes[themeName];
  const width = 360;
  const height = 458;
  const stats = [
    ['公开仓库', metrics.repositories],
    ['累计获赞', metrics.stars],
    ['关注者', metrics.followers],
    ['年度贡献', metrics.contributions.totalContributions],
  ];
  const statPositions = [
    [28, 86],
    [198, 86],
    [28, 148],
    [198, 148],
  ];
  const statMarkup = stats.map(([label, value], index) => {
    const [x, y] = statPositions[index];
    return [
      `<text x="${x}" y="${y}" class="stat-value">${formatNumber(value)}</text>`,
      `<text x="${x}" y="${y + 21}" class="stat-label">${label}</text>`,
    ].join('\n');
  }).join('\n');

  const totalLanguageSize = metrics.languages.reduce((sum, language) => sum + language.size, 0);
  let languageOffset = 20;
  const languageBarWidth = 320;
  const languageBar = metrics.languages.map((language, index) => {
    const remainingWidth = 20 + languageBarWidth - languageOffset;
    const segmentWidth = index === metrics.languages.length - 1
      ? remainingWidth
      : (language.size / totalLanguageSize) * languageBarWidth;
    const markup = `<rect x="${languageOffset.toFixed(2)}" y="232" width="${segmentWidth.toFixed(2)}" height="10" fill="${language.color || theme.muted}" />`;
    languageOffset += segmentWidth;
    return markup;
  }).join('\n');
  const languageLegend = metrics.languages.map((language, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 20 + column * 170;
    const y = 269 + row * 23;
    const percentage = totalLanguageSize === 0 ? 0 : (language.size / totalLanguageSize) * 100;
    const percentageLabel = percentage < 1 ? '&lt;1%' : `${Math.round(percentage)}%`;
    return [
      `<circle cx="${x + 4}" cy="${y - 3}" r="4" fill="${language.color || theme.muted}" />`,
      `<text x="${x + 14}" y="${y}" class="legend">${escapeXml(language.name)} · ${percentageLabel}</text>`,
    ].join('\n');
  }).join('\n');

  const weeks = metrics.contributions.weeks.slice(-52);
  const allDays = weeks.flatMap(({ contributionDays }) => contributionDays);
  const maxContribution = Math.max(0, ...allDays.map(({ contributionCount }) => contributionCount));
  const calendarX = 51;
  const calendarY = 400;
  const cellSize = 4.5;
  const cellPitch = 5.65;
  const calendarCells = weeks.flatMap(({ contributionDays }, weekIndex) => (
    contributionDays.map((day) => {
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const x = calendarX + weekIndex * cellPitch;
      const y = calendarY + weekday * cellPitch;
      const color = contributionColor(day.contributionCount, maxContribution, theme);
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize}" height="${cellSize}" rx="1" fill="${color}"><title>${escapeXml(day.date)}：${day.contributionCount} 次贡献</title></rect>`;
    })
  )).join('\n');
  const monthLabels = [];
  let previousMonth = null;
  let previousLabelX = -Infinity;
  weeks.forEach(({ contributionDays }, weekIndex) => {
    const firstDay = contributionDays[0];
    if (!firstDay) return;
    const month = new Date(`${firstDay.date}T00:00:00Z`).getUTCMonth() + 1;
    const x = calendarX + weekIndex * cellPitch;
    if (month !== previousMonth && x - previousLabelX >= 26) {
      monthLabels.push(`<text x="${x.toFixed(2)}" y="389" class="calendar-label">${month}月</text>`);
      previousLabelX = x;
    }
    previousMonth = month;
  });

  const updatedAt = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date());

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="458" viewBox="0 0 360 458" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(login)} 的 GitHub 开发数据</title>
  <desc id="description">公开仓库、获赞、关注者、年度贡献、语言占比和贡献日历</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
    .heading { fill: ${theme.text}; font-size: 18px; font-weight: 600; }
    .updated { fill: ${theme.muted}; font-size: 9px; }
    .stat-value { fill: ${theme.accent}; font-size: 22px; font-weight: 600; }
    .stat-label { fill: ${theme.muted}; font-size: 11px; }
    .section-title { fill: ${theme.text}; font-size: 13px; font-weight: 600; }
    .legend { fill: ${theme.muted}; font-size: 9px; }
    .calendar-label { fill: ${theme.muted}; font-size: 7px; }
  </style>
  <rect x="0.5" y="0.5" width="359" height="457" rx="6" fill="${theme.background}" stroke="${theme.border}" />
  <text x="20" y="31" class="heading">开发数据</text>
  <text x="340" y="29" text-anchor="end" class="updated">每日更新 · ${escapeXml(updatedAt)}</text>
  ${statMarkup}
  <line x1="180" y1="68" x2="180" y2="169" stroke="${theme.border}" />
  <line x1="20" y1="124" x2="340" y2="124" stroke="${theme.border}" />
  <line x1="20" y1="190" x2="340" y2="190" stroke="${theme.border}" />
  <text x="20" y="218" class="section-title">语言分布</text>
  <clipPath id="language-bar"><rect x="20" y="232" width="320" height="10" rx="5" /></clipPath>
  <g clip-path="url(#language-bar)">${languageBar}</g>
  ${languageLegend}
  <line x1="20" y1="337" x2="340" y2="337" stroke="${theme.border}" />
  <text x="20" y="367" class="section-title">贡献日历</text>
  <text x="20" y="409" class="calendar-label">周一</text>
  <text x="20" y="420" class="calendar-label">周三</text>
  <text x="20" y="432" class="calendar-label">周五</text>
  ${monthLabels.join('\n')}
  ${calendarCells}
</svg>
`;
}

const metrics = await loadMetrics();
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, '..', 'assets');
await mkdir(outputDirectory, { recursive: true });

await Promise.all(Object.keys(themes).flatMap((themeName) => [
  writeFile(
    resolve(outputDirectory, `github-metrics-${themeName}.svg`),
    renderSvg(metrics, themeName),
    'utf8',
  ),
  writeFile(
    resolve(outputDirectory, `github-metrics-mobile-${themeName}.svg`),
    renderMobileSvg(metrics, themeName),
    'utf8',
  ),
]));

console.log(`Generated profile metrics for ${login}`);
