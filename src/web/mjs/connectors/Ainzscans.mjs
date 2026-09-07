import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class Ainzscans extends Connector {

    constructor() {
        super();
        super.id = 'ainzscans';
        super.label = 'Ainz Scans';
        this.tags = [ 'manhwa', 'manhua', 'indonesian', 'scanlation' ];
        this.url = 'https://v3.ainzscans01.com';
        this.api = 'https://api.ainzscans01.com/api/';
    }

    canHandleURI(uri) {
        return /https?:\/\/(v\d+\.)?ainzscans(01)?\.(com|net)/.test(uri.origin);
    }

    async _initializeConnector() {
        const uri = new URL(this.url);
        const request = new Request(uri.href, this.requestOptions);
        this.url = await Engine.Request.fetchUI(request, 'window.location.origin');
        console.log(`Assigned URL '${this.url}' to ${this.label}`);
    }

    _cleanTitle(title, mangaTitle) {
        title = title || '';
        mangaTitle = mangaTitle || '';
        const cleaned = title.replace(mangaTitle, '').replace(/\s+Bahasa\s+Indonesia\s*$/i, '').trim();
        return (cleaned || title).trim();
    }

    async _getMangaFromURI(uri) {
        const segments = uri.pathname.split('/').filter(segment => segment.length > 0);
        const slug = segments[segments.indexOf('comic') + 1] || segments[segments.length - 1];
        try {
            const request = new Request(new URL('./series/comic/' + slug, this.api), this.requestOptions);
            const data = await this.fetchJSON(request);
            return new Manga(this, data.slug, this._cleanTitle(data.title));
        } catch (error) {
            const request = new Request(new URL('/comic/' + slug, this.url), this.requestOptions);
            const data = await this.fetchDOM(request, 'section h1.text-white');
            return new Manga(this, slug, this._cleanTitle(data[0].textContent));
        }
    }

    async _getMangas() {
        const mangaList = [];
        for (let page = 1, run = true; run; page++) {
            const mangas = await this._getMangasFromPage(page);
            if (mangas.length > 0) {
                mangaList.push(...mangas);
            } else {
                run = false;
            }
        }
        return mangaList;
    }

    async _getMangasFromPage(page) {
        const uri = new URL('./search?type=COMIC&limit=100&page=' + page + '&sort=latest&order=desc', this.api);
        const request = new Request(uri, this.requestOptions);
        const data = await this.fetchJSON(request);
        return (data.data || []).map(entry => {
            return {
                id: entry.slug,
                title: this._cleanTitle(entry.title)
            };
        });
    }

    async _getChapters(manga) {
        const request = new Request(new URL('./series/comic/' + manga.id, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return (data.units || [])
            .sort((self, other) => parseFloat(other.sort_number) - parseFloat(self.sort_number))
            .map(unit => {
                return {
                    id: unit.slug,
                    title: unit.number ? 'Chapter ' + parseFloat(unit.number) : unit.title || unit.slug
                };
            });
    }

    async _getPages(chapter) {
        const request = new Request(new URL('./series/comic/' + chapter.manga.id + '/chapter/' + chapter.id, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return data.chapter.pages.map(page => new URL(page.image_url, this.api).href.replace(/^http:/, 'https:'));
    }
}
