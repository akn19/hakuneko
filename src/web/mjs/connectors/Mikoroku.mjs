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
        this.mangaCategory = 'Series';
        this.chapterCategory = 'Chapter';
        // Add referer header like Mihon does
        this.requestOptions.headers.set('Referer', this.url + '/');
    }

    async _getMangas() {
        const mangalist = [];
        const feedUrl = new URL(`/feeds/posts/default/-/${this.mangaCategory}?orderby=published&alt=json&max-results=999`, this.url);
        const request = new Request(feedUrl, this.requestOptions);
        const data = await this.fetchJSON(request);

        if (data.feed && data.feed.entry) {
            for (const entry of data.feed.entry) {
                // Filter by manga category
                const hasCategory = entry.category && entry.category.some(cat => cat.term === this.mangaCategory);
                if (!hasCategory) continue;

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
        // Chapters are embedded in #chapterContainer as .chap-btn links
        const script = `
            new Promise(resolve => {
                const chapters = [];
                const chapterLinks = document.querySelectorAll('#chapterContainer a.chap-btn');
                chapterLinks.forEach(link => {
                    const chapNum = link.querySelector('.chap-num');
                    if (chapNum && link.href) {
                        chapters.push({
                            id: link.href,
                            title: chapNum.textContent.trim()
                        });
                    }
                });
                resolve(chapters);
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
