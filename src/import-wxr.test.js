import { describe, expect, it } from 'vitest';
import { parseWxr } from './import-wxr.js';

// A small, hand-written WXR fixture — not one of the owner's real exports
// (those carry personal data and shouldn't enter the repo) — covering one
// item of each shape the importer cares about.
const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
<title>My Old Blog</title>
<link>https://old.example.com</link>
<wp:base_site_url>https://old.example.com</wp:base_site_url>
<item>
  <title>Tea &amp; Recycling</title>
  <link>https://old.example.com/tea-recycling</link>
  <content:encoded><![CDATA[<p>Some tea &amp; a bag.</p>]]></content:encoded>
  <excerpt:encoded><![CDATA[]]></excerpt:encoded>
  <dc:creator><![CDATA[old_admin]]></dc:creator>
  <wp:post_id>101</wp:post_id>
  <wp:post_date_gmt>2024-01-05 10:00:00</wp:post_date_gmt>
  <wp:post_modified_gmt>2024-02-10 08:30:00</wp:post_modified_gmt>
  <wp:post_name><![CDATA[tea-recycling]]></wp:post_name>
  <wp:status>publish</wp:status>
  <wp:post_type>post</wp:post_type>
  <category domain="category" nicename="drinks"><![CDATA[Drinks]]></category>
  <category domain="post_tag" nicename="tea"><![CDATA[Tea]]></category>
  <wp:postmeta>
    <wp:meta_key>_thumbnail_id</wp:meta_key>
    <wp:meta_value>202</wp:meta_value>
  </wp:postmeta>
</item>
<item>
  <title>About</title>
  <link>https://old.example.com/about</link>
  <content:encoded><![CDATA[<p>About me.</p>]]></content:encoded>
  <wp:post_id>301</wp:post_id>
  <wp:post_name><![CDATA[about]]></wp:post_name>
  <wp:status>publish</wp:status>
  <wp:post_type>page</wp:post_type>
</item>
<item>
  <title>photo.jpg</title>
  <link>https://old.example.com/photo</link>
  <wp:post_id>202</wp:post_id>
  <wp:post_name><![CDATA[photo]]></wp:post_name>
  <wp:status>inherit</wp:status>
  <wp:post_type>attachment</wp:post_type>
  <wp:attachment_url><![CDATA[https://old.example.com/wp-content/uploads/photo.jpg]]></wp:attachment_url>
</item>
<item>
  <title>Old Draft I Never Finished</title>
  <link>https://old.example.com/?p=404</link>
  <content:encoded><![CDATA[<p>Half a thought.</p>]]></content:encoded>
  <wp:post_id>404</wp:post_id>
  <wp:post_name><![CDATA[]]></wp:post_name>
  <wp:status>trash</wp:status>
  <wp:post_type>post</wp:post_type>
</item>
</channel>
</rss>`;

describe('parseWxr', () => {
  const parsed = parseWxr(WXR);

  it('reads the channel header for the old site url, not an item link', () => {
    expect(parsed.site.title).toBe('My Old Blog');
    expect(parsed.site.url).toBe('https://old.example.com');
  });

  it('finds all four items regardless of post_type', () => {
    expect(parsed.items).toHaveLength(4);
  });

  it('decodes an entity-encoded title but leaves CDATA content untouched', () => {
    const post = parsed.items.find((i) => i.slug === 'tea-recycling');
    expect(post.title).toBe('Tea & Recycling');
    expect(post.contentHtml).toBe('<p>Some tea &amp; a bag.</p>');
  });

  it('extracts category and post_tag terms with their taxonomy', () => {
    const post = parsed.items.find((i) => i.slug === 'tea-recycling');
    expect(post.terms).toEqual([
      { taxonomy: 'category', name: 'Drinks' },
      { taxonomy: 'post_tag', name: 'Tea' },
    ]);
  });

  it('extracts the original post and modified dates', () => {
    const post = parsed.items.find((i) => i.slug === 'tea-recycling');
    expect(post.dateGmt).toBe('2024-01-05 10:00:00');
    expect(post.modifiedGmt).toBe('2024-02-10 08:30:00');
  });

  it('extracts postmeta key/value pairs, including _thumbnail_id', () => {
    const post = parsed.items.find((i) => i.slug === 'tea-recycling');
    expect(post.postmeta._thumbnail_id).toBe('202');
  });

  it('identifies a page item by post_type, distinct from a post', () => {
    const page = parsed.items.find((i) => i.title === 'About');
    expect(page.postType).toBe('page');
  });

  it('extracts an attachment item\'s attachment_url', () => {
    const attachment = parsed.items.find((i) => i.postType === 'attachment');
    expect(attachment.attachmentUrl).toBe('https://old.example.com/wp-content/uploads/photo.jpg');
    expect(attachment.postId).toBe('202');
  });

  it('preserves a trashed post\'s status rather than dropping it during parse', () => {
    const trashed = parsed.items.find((i) => i.postId === '404');
    expect(trashed.status).toBe('trash');
    expect(trashed.postType).toBe('post');
  });

  it('returns an empty items array for a channel with no items', () => {
    const empty = parseWxr('<rss><channel><title>Empty</title></channel></rss>');
    expect(empty.items).toEqual([]);
    expect(empty.site.title).toBe('Empty');
  });
});
