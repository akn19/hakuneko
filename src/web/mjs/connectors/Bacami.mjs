import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class Bacami extends Connector {

    constructor() {
        super();
        super.id = 'bacami';
        super.label = 'Bacami';
        this.tags = [ 'manga', 'indonesian' ];
        this.url = 'https://v1.bacami.site';
        this.requestOptions.headers.set('x-referer', this.url);
    }

    async _getMangaFromURI(uri) {
        let id = uri.pathname;
        if(!id.startsWith('/komik/')) {
            let request = new Request(uri, this.requestOptions);
            let data = await this.fetchDOM(request, 'div.breadcrumb a[href*="/komik/"]');
            id = this.getRootRelativeOrAbsoluteLink(data[0], request.url);
        }
        let request = new Request(new URL(id, this.url), this.requestOptions);
        let data = await this.fetchDOM(request, '#komik section.manga-content header h1');
        let title = data[0].textContent.replace(/Bahasa Indonesia\s*$/i, '').trim();
        return new Manga(this, id, title);
    }

    async _getMangas() {
        let request = new Request(new URL('/daftar-komik/', this.url), this.requestOptions);
        let data = await this.fetchDOM(request, 'article.daftar-komik ul li a.series');
        return data.map(element => {
            return {
                id: this.getRootRelativeOrAbsoluteLink(element, this.url),
                title: element.text.trim()
            };
        });
    }

    async _getChapters(manga) {
        let request = new Request(new URL(manga.id, this.url), this.requestOptions);
        let data = await this.fetchDOM(request, 'ol.chapter-list > li');
        return data.map(element => {
            let link = element.querySelector('a.ch-link');
            let raw = link.textContent.trim();
            // e.g. 'One Piece – Chapter 1194' => 'Chapter 1194' (same as tachiyomi extension)
            let title = this._substringAfter(this._substringAfter(raw, '–'), '-').trim() || raw;
            return {
                id: this.getRootRelativeOrAbsoluteLink(link, this.url),
                title: title
            };
        });
    }

    async _getPages(chapter) {
        let request = new Request(new URL(chapter.id, this.url), this.requestOptions);
        let data = await this.fetchRegex(request, /imageUrls:\s*(\[[\s\S]*?\])/g);
        return JSON.parse(data[0]);
    }

    _substringAfter(text, separator) {
        let index = text.indexOf(separator);
        return index < 0 ? text : text.slice(index + separator.length);
    }
}
