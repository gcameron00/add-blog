/**
 * Public single-post view.
 *
 * Reads `?slug=` because a static-asset deployment cannot express `/posts/<slug>`
 * as a file. Phase 3 moves this to a Worker-rendered permalink for SEO and
 * first-paint, and keeps this URL working as a redirect — see
 * docs/architecture.md §2.
 */

import * as api from './api.js';
import { el, clear, append, icon, timeEl, renderError } from './main.js';
import { tagChip } from './blog.js';

const article = document.querySelector('[data-article]');
const slug = new URLSearchParams(location.search).get('slug');

function setMeta(post) {
  document.title = `${post.title} — The add-blog Journal`;

  const set = (selector, attr, value) => {
    const node = document.head.querySelector(selector);
    if (node) node.setAttribute(attr, value);
  };
  set('meta[name="description"]', 'content', post.excerpt);
  set('meta[property="og:title"]', 'content', post.title);
  set('meta[property="og:description"]', 'content', post.excerpt);
  set('link[rel="canonical"]', 'href', `${location.origin}/posts/${post.slug}`);
}

/** Add a click-to-copy anchor to every h2/h3 in the rendered body. */
function addHeadingLinks(container) {
  for (const heading of container.querySelectorAll('h2[id], h3[id]')) {
    const anchor = el('a', {
      class: 'heading-anchor',
      href: `#${heading.id}`,
      'aria-label': `Link to “${heading.textContent}”`,
      text: '#',
    });
    heading.append(anchor);
  }
}

function renderPost(post) {
  setMeta(post);

  const header = el('header', { class: 'article-header' }, [
    el('div', { class: 'tag-list', style: 'margin-bottom:1rem' }, (post.tags || []).map((t) => tagChip(t))),
    el('h1', { text: post.title }),
    post.subtitle ? el('p', { class: 'subtitle', text: post.subtitle }) : null,
  ]);

  const byline = el('div', { class: 'byline' }, [
    post.author?.avatar
      ? el('img', { class: 'byline__avatar', src: post.author.avatar, alt: '' })
      : null,
    el('div', {}, [
      el('div', { class: 'byline__name', text: post.author?.name || 'Unknown author' }),
      el('div', { class: 'byline__meta' }, [
        timeEl(post.published_at),
        el('span', { text: ` · ${post.reading_minutes} min read` }),
        post.updated_at && post.updated_at !== post.published_at
          ? el('span', { text: ' · updated ' })
          : null,
        post.updated_at && post.updated_at !== post.published_at
          ? timeEl(post.updated_at, { relative: true })
          : null,
      ]),
    ]),
  ]);

  // `body_html` is the one place innerHTML is used on the public site. It comes
  // from the escaping-first renderer in markdown.js (Phase 1) or the sanitised
  // server-side render stored in D1 (Phase 3+) — never from raw user input.
  const body = el('div', { class: 'prose', html: post.body_html || '' });
  addHeadingLinks(body);

  const footer = el('footer', { class: 'article-footer' }, [
    el('div', { class: 'tag-list' }, (post.tags || []).map((t) => tagChip(t))),
    el('p', { class: 'small muted', style: 'margin-top:1rem' }, [
      el('a', { href: '/', text: '← All posts' }),
    ]),
  ]);

  append(clear(article),
    header,
    post.cover ? el('img', { class: 'article-cover', src: post.cover.url, alt: post.cover.alt || '' }) : null,
    byline,
    body,
    footer,
    post.related?.length
      ? el('section', { class: 'related' }, [
          el('h2', { text: 'Related posts' }),
          el('ul', {}, post.related.map((related) =>
            el('li', {}, [
              el('a', { href: `/post/?slug=${encodeURIComponent(related.slug)}`, text: related.title }),
              el('div', { class: 'post-meta' }, [timeEl(related.published_at)]),
            ])
          )),
        ])
      : null
  );
}

async function load() {
  if (!slug) {
    clear(article).append(
      el('div', { class: 'empty-state' }, [
        icon('file'),
        el('h2', { text: 'No post specified' }),
        el('p', { text: 'This page needs a ?slug= parameter.' }),
        el('a', { class: 'btn', href: '/', text: 'Back to all posts' }),
      ])
    );
    return;
  }

  try {
    const { data } = await api.getPost(slug);
    renderPost(data);
  } catch (error) {
    if (error?.status === 404) {
      clear(article).append(
        el('div', { class: 'empty-state' }, [
          icon('file'),
          el('h2', { text: 'Post not found' }),
          el('p', { text: `Nothing is published at “${slug}”. It may have been unpublished or renamed.` }),
          el('a', { class: 'btn', href: '/', text: 'Back to all posts' }),
        ])
      );
      return;
    }
    renderError(article, error, load);
  }
}

load();
