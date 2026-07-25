/**
 * Public blog: home, archive and tag pages.
 *
 * One module, switched on `<body data-page>`, because the three views share the
 * post-card builder and little else.
 */

import * as api from './api.js';
import { el, clear, timeEl, skeletonList, renderError, renderEmpty } from './main.js';

const PAGE_SIZE = 6;

/* --- Shared pieces -------------------------------------------------------- */

export function tagChip(tag, { active = false } = {}) {
  return el('a', {
    class: `tag${active ? ' tag--active' : ''}`,
    href: `/tags/?tag=${encodeURIComponent(tag.slug)}`,
    text: tag.name,
  }, tag.post_count !== undefined
    ? [el('span', { class: 'tag__count', text: ` ${tag.post_count}` })]
    : []);
}

function postMeta(post) {
  return el('div', { class: 'post-meta' }, [
    post.author && el('span', { text: post.author.name }),
    post.author && el('span', { class: 'post-meta__sep', text: '·' }),
    timeEl(post.published_at),
    el('span', { class: 'post-meta__sep', text: '·' }),
    el('span', { text: `${post.reading_minutes} min read` }),
  ]);
}

export function postCard(post, { featured = false } = {}) {
  const href = `/post/?slug=${encodeURIComponent(post.slug)}`;
  const hasCover = Boolean(post.cover);

  const body = el('div', {}, [
    el('h2', { class: 'post-card__title' }, [el('a', { href, text: post.title })]),
    // The subtitle only earns its space on the featured card.
    featured && post.subtitle
      ? el('p', { class: 'muted', style: 'margin-bottom:.5rem', text: post.subtitle })
      : null,
    el('p', { class: 'post-card__excerpt', text: post.excerpt }),
    postMeta(post),
    post.tags?.length
      ? el('div', { class: 'tag-list', style: 'margin-top:.75rem' }, post.tags.map((t) => tagChip(t)))
      : null,
  ]);

  const classes = ['post-card'];
  if (featured) classes.push('post-card--featured');
  if (!hasCover) classes.push('post-card--no-cover');

  return el('article', { class: classes.join(' ') }, [
    hasCover
      ? el('a', { href, 'aria-hidden': 'true', tabindex: '-1' }, [
          el('img', { class: 'post-card__cover', src: post.cover.url, alt: '', loading: 'lazy' }),
        ])
      : null,
    body,
  ]);
}

/* --- Home ----------------------------------------------------------------- */

async function initHome() {
  const list = document.querySelector('[data-post-list]');
  const tagBar = document.querySelector('[data-tag-bar]');
  const search = document.querySelector('[data-search]');
  const more = document.querySelector('[data-load-more]');

  const state = { q: new URLSearchParams(location.search).get('q') || '', offset: 0 };
  if (search) search.value = state.q;

  async function load({ append = false } = {}) {
    if (!append) {
      state.offset = 0;
      skeletonList(list, 3);
    }
    try {
      const { data, page } = await api.listPosts({ limit: PAGE_SIZE, offset: state.offset, q: state.q });
      if (!append) clear(list);

      if (!data.length && !append) {
        renderEmpty(list, {
          title: state.q ? `No posts match “${state.q}”` : 'No posts yet',
          body: state.q ? 'Try a different search term.' : 'The first post will appear here.',
        });
        if (more) more.hidden = true;
        return;
      }

      const firstPage = state.offset === 0;
      data.forEach((post, index) => {
        list.append(postCard(post, { featured: firstPage && index === 0 && !state.q }));
      });
      state.offset += data.length;
      if (more) more.hidden = !page.has_more;
    } catch (error) {
      renderError(list, error, () => load());
    }
  }

  more?.addEventListener('click', () => load({ append: true }));

  let debounce;
  search?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = search.value.trim();
      const url = new URL(location.href);
      if (state.q) url.searchParams.set('q', state.q);
      else url.searchParams.delete('q');
      history.replaceState(null, '', url);
      load();
    }, 220);
  });

  if (tagBar) {
    try {
      const { data } = await api.listTags();
      clear(tagBar).append(...data.slice(0, 8).map((t) => tagChip(t)));
    } catch {
      tagBar.hidden = true;
    }
  }

  load();
}

/* --- Archive -------------------------------------------------------------- */

async function initArchive() {
  const container = document.querySelector('[data-archive]');
  skeletonList(container, 4);
  try {
    const { data } = await api.getArchive();
    clear(container);
    if (!data.length) {
      renderEmpty(container, { title: 'Nothing archived yet' });
      return;
    }
    for (const group of data) {
      container.append(
        el('section', { class: 'archive-year' }, [
          el('h2', { text: `${group.year} — ${group.posts.length} post${group.posts.length === 1 ? '' : 's'}` }),
          el('ul', { class: 'archive-list' }, group.posts.map((post) =>
            el('li', {}, [
              timeEl(post.published_at),
              el('a', { href: `/post/?slug=${encodeURIComponent(post.slug)}`, text: post.title }),
              el('span', { class: 'muted small', style: 'margin-left:auto', text: `${post.reading_minutes} min` }),
            ])
          )),
        ])
      );
    }
  } catch (error) {
    renderError(container, error, initArchive);
  }
}

/* --- Tags ----------------------------------------------------------------- */

async function initTags() {
  const cloud = document.querySelector('[data-tag-cloud]');
  const results = document.querySelector('[data-tag-results]');
  const heading = document.querySelector('[data-tag-heading]');
  const active = new URLSearchParams(location.search).get('tag');

  try {
    const { data } = await api.listTags();
    clear(cloud).append(
      el('a', { class: `tag${active ? '' : ' tag--active'}`, href: '/tags/', text: 'All' }),
      ...data.map((t) => tagChip(t, { active: t.slug === active }))
    );
  } catch (error) {
    renderError(cloud, error, initTags);
    return;
  }

  if (!active) {
    heading.textContent = 'Browse by tag';
    renderEmpty(results, {
      title: 'Pick a tag',
      body: 'Choose a tag above to see the posts filed under it.',
    });
    return;
  }

  heading.textContent = `Tagged “${active}”`;
  document.title = `Tagged “${active}” — The add-blog Journal`;
  skeletonList(results, 2);

  try {
    const { data } = await api.listPosts({ tag: active, limit: 50 });
    clear(results);
    if (!data.length) {
      renderEmpty(results, { title: 'No posts with this tag yet' });
      return;
    }
    data.forEach((post) => results.append(postCard(post)));
  } catch (error) {
    renderError(results, error, initTags);
  }
}

/* --- Dispatch ------------------------------------------------------------- */

const PAGES = { home: initHome, archive: initArchive, tags: initTags };

const start = () => PAGES[document.body.dataset.page]?.();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
