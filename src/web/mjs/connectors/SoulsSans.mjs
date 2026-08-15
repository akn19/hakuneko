import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class SoulsSans extends Connector {

    constructor() {
        super();
        super.id = 'soulscans';
        super.label = 'Soul Scans';
        this.tags = ['manga', 'manhwa', 'manhua', 'indonesian'];
        this.url = 'https://v1.soulscans.org';
        this.api = 'https://img.soulscans.org/api/';
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split('/').pop();
        const request = new Request(new URL(`series/comic/${slug}`, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return new Manga(this, data.slug, data.title.trim());
    }

    async _getMangas() {
        let mangaList = [];
        for (let page = 1, run = true; run; page++) {
            const mangas = await this._getMangasFromPage(page);
            if (mangas.length === 0) {
                run = false;
            } else {
                mangaList.push(...mangas);
            }
        }
        return mangaList;
    }

    async _getMangasFromPage(page) {
        const uri = new URL('search', this.api);
        uri.searchParams.set('type', 'COMIC');
        uri.searchParams.set('page', page);
        uri.searchParams.set('limit', '100');
        const request = new Request(uri, this.requestOptions);
        const data = await this.fetchJSON(request);
        return data.data.map(entry => {
            return {
                id: entry.slug,
                title: entry.title.trim()
            };
        });
    }

    async _getChapters(manga) {
        const request = new Request(new URL(`series/comic/${manga.id}`, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return data.units.map(unit => {
            return {
                id: unit.slug,
                title: unit.number ? `Chapter ${Number(unit.number)}` : unit.title
            };
        });
    }

    async _getPages(chapter) {
        const request = new Request(new URL(`series/comic/${chapter.manga.id}/chapter/${chapter.id}`, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return data.chapter.pages.map(page => page.image_url.replace(/^http:/, 'https:'));
    }
}
