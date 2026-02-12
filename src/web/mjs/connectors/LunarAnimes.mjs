import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class LunarAnimes extends Connector {

    constructor() {
        super();
        super.id = 'lunaranimes';
        super.label = 'Lunar Animes';
        this.tags = ['manga', 'manhwa', 'manhua', 'multi-lingual', 'aggregator'];
        this.url = 'https://lunaranime.ru';
        this.apiUrl = 'https://api.lunaranime.ru/api/manga/';
        this.requestDelay = 500; // Delay in milliseconds between API requests

        this.languageMap = {
            'zh': 'Chinese',
            'en': 'English',
            'id': 'Indonesian',
            'ja': 'Japanese',
            'ko': 'Korean',
            'pl': 'Polish',
            'pt': 'Portuguese',
            'ru': 'Russian',
            'es': 'Spanish',
            'th': 'Thai',
            'tr': 'Turkish',
            'vi': 'Vietnamese',
        };
    }

    async _wait() {
        return new Promise(resolve => setTimeout(resolve, this.requestDelay));
    }

    canHandleURI(uri) {
        return /https?:\/\/lunaranime\.ru\/manga\/[^/]+/.test(uri.href);
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split('/').pop();
        const request = new Request(new URL(this.url + uri.pathname), this.requestOptions);
        const data = await this.fetchDOM(request, 'meta[property="og:title"]');
        const title = data[0].content.trim();
        return new Manga(this, slug, title);
    }

    async _getMangas() {
        await this._wait();
        const request = new Request(new URL('search?', this.apiUrl), this.requestOptions);
        const { manga } = await this.fetchJSON(request);
        return manga.map(entry => ({
            id: entry.slug,
            title: entry.title,
        }));
    }

    async _getChapters(manga) {
        await this._wait();
        const request = new Request(new URL(manga.id, this.apiUrl), this.requestOptions);
        const { data } = await this.fetchJSON(request);
        return data.map(chapter => ({
            id: `${manga.id}/${chapter.chapter_number}?language=${chapter.language}`,
            title: `Chapter ${chapter.chapter_number} (${chapter.language})`,
            language: chapter.language,
        }));
    }

    async _getPages(chapter) {
        await this._wait();
        const request = new Request(new URL(chapter.id, this.apiUrl), this.requestOptions);
        const { data: { images } } = await this.fetchJSON(request);
        return images;
    }
}
