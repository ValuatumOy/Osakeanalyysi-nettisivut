import { directoryBucket, directoryPath } from './directory-bucket.mjs';

const SITE = 'https://www.aiequityreports.com';
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function directoryBreadcrumbItems(name, url) {
  return [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: 'Companies', item: `${SITE}/companies.html` },
    { '@type': 'ListItem', position: 3, name: directoryBucket(name), item: `${SITE}${directoryPath(name)}` },
    { '@type': 'ListItem', position: 4, name, item: url },
  ];
}

export function directoryBreadcrumbHtml(name) {
  const letter = directoryBucket(name);
  return `<nav aria-label="Breadcrumb" style="font-size:var(--text-xs); color:rgba(255,255,255,0.6); margin-bottom:1rem;">
          <a href="/" style="color:rgba(255,255,255,0.7);">Home</a> &rsaquo;
          <a href="/companies.html" style="color:rgba(255,255,255,0.7);">Companies</a> &rsaquo;
          <a href="${directoryPath(name)}" style="color:rgba(255,255,255,0.7);">${letter}</a> &rsaquo;
          <span>${esc(name)}</span>
        </nav>`;
}
