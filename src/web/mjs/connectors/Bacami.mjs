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
        let dom = await this.fetchDOM(request);
        let mangaList = [...dom.querySelectorAll('article.daftar-komik ul li a.series')].map(element => {
            return {
                id: this.getRootRelativeOrAbsoluteLink(element, this.url),
                title: element.text.trim()
            };
        });
        // only sections '#', 'A' - 'C' are rendered server side,
        // the remaining letters are lazy loaded through an AJAX endpoint (see 'script#komik-load-more-data')
        let configElement = dom.querySelector('script#komik-load-more-data');
        if(configElement) {
            let config = JSON.parse(configElement.textContent);
            if(config.letters && config.letters.length > 0) {
                let html = await this._fetchLazyKomikList(config.letters, config.exclude || []);
                let lazyDOM = this.createDOM(html);
                [...lazyDOM.querySelectorAll('article.daftar-komik ul li a.series')].forEach(element => {
                    mangaList.push({
                        id: this.getRootRelativeOrAbsoluteLink(element, this.url),
                        title: element.text.trim()
                    });
                });
            }
        }
        return mangaList;
    }

    async _fetchLazyKomikList(letters, exclude) {
        let lettersStr = JSON.stringify(letters);
        let timeSeed = Math.floor(Date.now() / 1000);
        // proof-of-work required by the endpoint: SHA-256 hash of 'timeSeed_letters_nonce' must start with '0000'
        let nonce = -1;
        let hash = '';
        while(!hash.startsWith('0000') && nonce < 500000) {
            nonce++;
            hash = CryptoJS.SHA256(timeSeed + '_' + lettersStr + '_' + nonce).toString(CryptoJS.enc.Hex);
        }
        if(!hash.startsWith('0000')) {
            throw new Error('Failed to solve proof-of-work for manga list!');
        }
        let uri = new URL('/wp-admin/admin-ajax.php', this.url);
        let form = new FormData();
        form.append('action', 'load_more_komik');
        form.append('timeSeed', timeSeed);
        form.append('pow_nonce', nonce);
        form.append('letters', lettersStr);
        form.append('exclude_ids', exclude.join(','));
        let request = new Request(uri, { ...this.requestOptions, method: 'POST', body: form });
        let data = await this.fetchJSON(request);
        if(!data.success) {
            throw new Error('Failed to load remaining manga list!');
        }
        return data.data.html;
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
