import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class Mgkomik extends Connector {

    constructor() {
        super();
        super.id = 'mgkomik';
        super.label = 'MGKOMIK';
        this.tags = [ 'webtoon', 'indonesian' ];
        this.url = 'https://web1.mgkomik.cc';

        this.queryMangas = 'a.manga-title';
        this.queryChapters = '#chapterList a.chapter-link';
        this.queryPages = '#readingContent source';
        this.queryTitleForURI = 'meta[property="og:title"], h1#mangaTitle, h1.manga-title';

        this.requestOptions.headers.set('x-referer', this.url + '/');
    }

    canHandleURI(uri) {
        return uri.hostname === new URL(this.url).hostname && uri.pathname.startsWith('/komik/');
    }

    _createMangaRequest(page) {
        let uri = new URL('/komik/', this.url);
        uri.searchParams.set('filter', '');
        uri.searchParams.set('order_by', 'alphabet');
        uri.searchParams.set('page', page);
        return new Request(uri, this.requestOptions);
    }

    _assertReadablePage(dom, requestURL) {
        let title = dom.querySelector('title');
        title = title ? title.textContent : '';
        if (/just a moment|attention required|cloudflare/i.test(title) || dom.querySelector('form#challenge-form')) {
            throw new Error('Cloudflare challenge was returned for ' + requestURL);
        }
    }

    _getMangaID(uri) {
        let match = uri.pathname.match(/^\/komik\/[^/]+\/?/);
        if (!match) {
            throw new Error('Invalid MGKOMIK manga URL: ' + uri.href);
        }
        return match[0].endsWith('/') ? match[0] : match[0] + '/';
    }

    _getCleanTitle(title) {
        return title.replace(/\s+/g, ' ').replace(/\s*-\s*MGKOMIK\s*$/i, '').trim();
    }

    _getTotalPages(dom) {
        let scripts = [...dom.querySelectorAll('script')].map(script => script.textContent).join('\n');
        let match = scripts.match(/totalPages\s*=\s*(\d+)/);
        if (match) {
            return Number(match[1]);
        }

        let pages = [...dom.querySelectorAll('.pagination a[href*="page="]')].map(link => {
            return Number(new URL(this.getAbsolutePath(link, this.url)).searchParams.get('page'));
        });
        return Math.max(...pages.filter(page => page), 1);
    }

    async _getMangaFromURI(uri) {
        let id = this._getMangaID(uri);
        let request = new Request(new URL(id, this.url), this.requestOptions);
        let data = await this.fetchDOM(request, this.queryTitleForURI);
        let element = [...data].shift();
        let title = element ? this._getCleanTitle(element.content || element.textContent) : id.split('/').filter(part => part).pop();
        return new Manga(this, id, title);
    }

    async _getMangas() {
        let mangaList = [];
        let totalPages = 1;
        for (let page = 1; page <= totalPages; page++) {
            let data = await this._getMangasPage(page);
            totalPages = Math.max(totalPages, data.totalPages);
            if (!data.mangas.length) {
                break;
            }
            mangaList.push(...data.mangas);
        }
        return mangaList;
    }

    async _getMangasPage(page) {
        let request = this._createMangaRequest(page);
        let dom = (await this.fetchDOM(request, 'body'))[0];
        this._assertReadablePage(dom, request.url);
        let mangas = [...dom.querySelectorAll(this.queryMangas)].map(element => {
            return {
                id: this.getRootRelativeOrAbsoluteLink(element, request.url),
                title: this._getCleanTitle(element.textContent)
            };
        });
        return {
            mangas,
            totalPages: this._getTotalPages(dom)
        };
    }

    async _getMangasFromPage(page) {
        return (await this._getMangasPage(page)).mangas;
    }

    async _getChapters(manga) {
        let request = new Request(new URL(manga.id, this.url), this.requestOptions);
        let dom = (await this.fetchDOM(request, 'body'))[0];
        this._assertReadablePage(dom, request.url);
        let data = [...dom.querySelectorAll(this.queryChapters)];
        if (!data.length) {
            throw new Error('No chapters found for ' + manga.title);
        }

        return data.map(element => {
            let title = element.querySelector('.chapter-number') || element;
            return {
                id: this.getRootRelativeOrAbsoluteLink(element, request.url),
                title: this._getCleanTitle(title.textContent),
                language: ''
            };
        });
    }

    async _getPages(chapter) {
        let request = new Request(new URL(chapter.id, this.url), this.requestOptions);
        let dom = (await this.fetchDOM(request, 'body'))[0];
        this._assertReadablePage(dom, request.url);
        let pages = [...dom.querySelectorAll(this.queryPages)].map(element => {
            let link = element.dataset['src'] || element.dataset['url'] || element.getAttribute('src') || element.getAttribute('srcset');
            if (!link) {
                return undefined;
            }
            link = link.split(',').shift().trim().split(/\s+/).shift();
            return this.createConnectorURI({
                url: this.getAbsolutePath(link, request.url),
                referer: request.url
            });
        }).filter(page => page);

        if (!pages.length) {
            throw new Error('No pages found for ' + chapter.title);
        }
        return pages;
    }

    async _handleConnectorURI(payload) {
        let request = new Request(payload.url, this.requestOptions);
        request.headers.set('x-referer', payload.referer || this.url + '/');
        let response = await fetch(request);
        let data = await response.blob();
        data = await this._blobToBuffer(data);
        this._applyRealMime(data);
        return data;
    }
}
