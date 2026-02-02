import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class Mikoroku extends Connector {
    constructor() {
        super();
        super.id = 'mikoroku';
        super.label = 'Mikoroku';
        this.tags = ['manga', 'scanlation', 'indonesian'];
        this.url = 'https://www.mikoroku.my.id';
        this.queryMangaTitle = 'h1[itemprop="name"]';
    }

    async _getMangas() {
        const mangalist = [];
        const feedUrl = new URL('/feeds/posts/default/-/Series?orderby=published&alt=json&max-results=999', this.url);
        const request = new Request(feedUrl, this.requestOptions);
        const data = await this.fetchJSON(request);

        if (data.feed && data.feed.entry) {
            for (const entry of data.feed.entry) {
                const altLink = entry.link.find(link => link.rel === 'alternate');
                if (altLink) {
                    mangalist.push({
                        id: this.getRootRelativeOrAbsoluteLink(altLink.href, this.url),
                        title: entry.title && entry.title.$t ? entry.title.$t.trim() : 'Unknown'
                    });
                }
            }
        }
        return mangalist;
    }

    async _getChapters(manga) {
        const request = new Request(new URL(manga.id, this.url), this.requestOptions);

        // Extract chapters directly from the manga page HTML
        // Three possible structures:
        // 1. div.chapter-list-section div#chapterContainer a.chap-btn span.chap-num
        // 2. div#download div.index-list a
        // 3. div#clwd ul li div.eph-num a span.chapternum
        const script = `
            new Promise(resolve => {
                // Normalize chapter title to standard "Chapter X" format
                const normalizeChapterTitle = (title) => {
                    if (!title) return title;

                    // Remove extra whitespace and trim
                    const cleanTitle = title.trim().replace(/\s+/g, ' ');

                    // Match patterns like "Ch. 03", "Ch 03", "Chapter 03", "ch.03", etc.
                    const match = cleanTitle.match(/(?:ch\.?|chapter)[\s\.]*(\d+(?:\.\d+)?)/i);
                    if (match) {
                        const num = parseFloat(match[1]);
                        return 'Chapter ' + num;
                    }

                    return title;
                };

                const getChapters = () => {
                    const chapters = [];

                    // Try first structure: chapterContainer
                    let chapterLinks = document.querySelectorAll('div.chapter-list-section div#chapterContainer a.chap-btn, #chapterContainer a.chap-btn');
                    if (chapterLinks.length > 0) {
                        chapterLinks.forEach(link => {
                            const chapNum = link.querySelector('span.chap-num, .chap-num');
                            if (chapNum && link.href) {
                                chapters.push({
                                    id: link.href,
                                    title: normalizeChapterTitle(chapNum.textContent.trim())
                                });
                            }
                        });
                    }

                    // Try second structure: index-list
                    if (chapters.length === 0) {
                        chapterLinks = document.querySelectorAll('div#download div.index-list a, div.index-list a');
                        chapterLinks.forEach(link => {
                            if (link.href && link.textContent) {
                                chapters.push({
                                    id: link.href,
                                    title: normalizeChapterTitle(link.textContent.trim())
                                });
                            }
                        });
                    }

                    // Try third structure: clwd epcheck
                    if (chapters.length === 0) {
                        chapterLinks = document.querySelectorAll('div#clwd ul li div.eph-num a');
                        chapterLinks.forEach(link => {
                            const chapNum = link.querySelector('span.chapternum');
                            if (chapNum && link.href) {
                                chapters.push({
                                    id: link.href,
                                    title: normalizeChapterTitle(chapNum.textContent.trim())
                                });
                            } else if (link.href && link.textContent) {
                                chapters.push({
                                    id: link.href,
                                    title: normalizeChapterTitle(link.textContent.trim())
                                });
                            }
                        });
                    }

                    return chapters;
                };

                // Try immediately first
                let chapters = getChapters();
                if (chapters.length > 0) {
                    resolve(chapters);
                    return;
                }

                // If no chapters found, wait and retry
                let attempts = 0;
                const maxAttempts = 10;
                const interval = setInterval(() => {
                    attempts++;
                    chapters = getChapters();
                    if (chapters.length > 0 || attempts >= maxAttempts) {
                        clearInterval(interval);
                        resolve(chapters);
                    }
                }, 500);
            });
        `;

        const chapters = await Engine.Request.fetchUI(request, script);
        return chapters || [];
    }

    async _getPages(chapter) {
        // Chapter URL is on mikodrive.my.id domain
        const chapterUrl = chapter.id.startsWith('http') ? chapter.id : new URL(chapter.id, this.url).href;
        const request = new Request(chapterUrl, this.requestOptions);

        // Based on user's path: main div#main div#Blog1 div.max-w
        // And Mihon's pageListSelector = "article#reader div.separator a, article#reader"
        const script = `
            new Promise(resolve => {
                const images = [];

                // Try multiple selectors - mikodrive structure
                const selectors = [
                    'div#Blog1 div.max-w div.separator a',
                    'div#Blog1 div.separator a',
                    'article#reader div.separator a',
                    'div.separator a',
                    'div#Blog1 div.max-w img',
                    'div#Blog1 img',
                    'article#reader img'
                ];

                for (const selector of selectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        elements.forEach(el => {
                            // If it's an anchor, get href
                            if (el.tagName === 'A' && el.href) {
                                // Check if href is image or get img inside
                                if (/\\.(jpg|jpeg|png|gif|webp)/i.test(el.href) || el.href.includes('blogger.googleusercontent.com')) {
                                    images.push(el.href);
                                } else {
                                    const img = el.querySelector('img');
                                    if (img && img.src && !img.src.includes('data:image')) {
                                        images.push(img.src);
                                    }
                                }
                            }
                            // If it's an image
                            else if (el.tagName === 'IMG' && el.src && !el.src.includes('data:image')) {
                                images.push(el.src);
                            }
                        });
                        if (images.length > 0) break;
                    }
                }

                resolve(images);
            });
        `;

        return await Engine.Request.fetchUI(request, script);
    }

    async _getMangaFromURI(uri) {
        const request = new Request(uri, this.requestOptions);
        const id = uri.pathname + uri.search;
        const dom = await this.fetchDOM(request, this.queryMangaTitle);
        const title = dom.length > 0 ? dom[0].textContent.trim() : 'Unknown';
        return new Manga(this, id, title);
    }
}
