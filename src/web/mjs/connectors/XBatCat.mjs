import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

// GraphQL Queries
const COMIC_NODE_DATA = `
    id
    name
    altNames
    authors
    artists
    originalStatus
    uploadStatus
    genres
    summary
    extraInfo
    urlPath
    urlCoverOri
`;

const COMIC_SEARCH_QUERY = `
    query ($select: Comic_Browse_Select) {
        get_comic_browse(select: $select) {
            paging {
                next
            }
            items {
                data {
                    ${COMIC_NODE_DATA}
                }
            }
        }
    }
`;

const COMIC_NODE_QUERY = `
    query get_comicNode($id: ID!) {
        get_comicNode(id: $id) {
            data {
                ${COMIC_NODE_DATA}
            }
        }
    }
`;

const CHAPTER_LIST_QUERY = `
    query get_comic_chapterList($comicId: ID!, $start: Int) {
        get_comic_chapterList(comicId: $comicId, start: $start) {
            data {
                comicId
                id
                serial
                dname
                title
                dateCreate
                dateModify
                userNode {
                    data {
                        name
                    }
                }
                groupNodes {
                    data {
                        name
                    }
                }
            }
        }
    }
`;

const CHAPTER_NODE_QUERY = `
    query get_chapterNode($id: ID!) {
        get_chapterNode(id: $id) {
            data {
                id
                comicId
                imageFile {
                    urlList
                }
            }
        }
    }
`;

export default class XBatCat extends Connector {
    constructor() {
        super();
        super.id = 'xbatcat';
        super.label = 'XBatCat';
        this.tags = ['manga', 'webtoon', 'english'];
        this.url = 'https://xbat.app';
        this.apiUrl = 'https://xbat.app/ap2/';

        this.requestOptions = JSON.parse(JSON.stringify(this.requestOptions));
        this.requestOptions.headers['Referer'] = this.url + '/';
    }

    async _getMangaFromURI(uri) {
        const id = this._extractIdFromUrl(uri.pathname);

        const variables = { id };
        const data = await this._graphQLRequest(variables, COMIC_NODE_QUERY);
        const comic = data.get_comicNode.data;

        return new Manga(this, comic.id, comic.name.trim());
    }

    async _getMangas() {
        const mangaList = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const variables = {
                select: {
                    page: page,
                    size: 36,
                    where: 'browse',
                    word: '',
                    sortby: 'popular',
                    incGenres: [],
                    excGenres: [],
                    incOLangs: [],
                    incTLangs: [],
                    origStatus: '',
                    siteStatus: '',
                    chapCount: '',
                    ignoreGlobalGenres: false
                }
            };

            const data = await this._graphQLRequest(variables, COMIC_SEARCH_QUERY);
            const response = data.get_comic_browse;

            const mangas = response.items.map(item => {
                return {
                    id: item.data.id,
                    title: item.data.name.trim()
                };
            });

            mangaList.push(...mangas);
            hasMore = response.paging.next !== 0;
            page++;

            // Limit to prevent infinite loops
            if (page > 100) break;
        }

        return mangaList;
    }

    async _getChapters(manga) {
        const variables = {
            comicId: manga.id,
            start: -1
        };

        const data = await this._graphQLRequest(variables, CHAPTER_LIST_QUERY);
        const chapters = data.get_comic_chapterList;

        return chapters.map(chapter => {
            const chapterData = chapter.data;
            let chapterName = '';

            // Build chapter name
            if (chapterData.serial != null) {
                const number = chapterData.serial.toString().replace('.0', '');
                if (!chapterData.dname.includes(number)) {
                    chapterName += `Chapter ${number}: `;
                }
            }

            chapterName += chapterData.dname;

            if (chapterData.title) {
                chapterName += `: ${chapterData.title}`;
            }

            return {
                id: chapterData.id,
                title: chapterName,
                language: ''
            };
        }).reverse();
    }

    async _getPages(chapter) {
        const variables = {
            id: chapter.id
        };

        const data = await this._graphQLRequest(variables, CHAPTER_NODE_QUERY);
        const chapterData = data.get_chapterNode.data;
        const imageUrls = chapterData.imageFile.urlList;

        return imageUrls.map(url => this.getAbsolutePath(url, this.url));
    }

    async _graphQLRequest(variables, query) {
        const request = new Request(this.apiUrl, {
            method: 'POST',
            body: JSON.stringify({
                variables: variables,
                query: query
            }),
            headers: {
                'Content-Type': 'application/json',
                'Referer': this.url + '/'
            }
        });

        const response = await fetch(request);
        const json = await response.json();

        if (json.errors) {
            throw new Error(`GraphQL Error: ${JSON.stringify(json.errors)}`);
        }

        return json.data;
    }

    _extractIdFromUrl(pathname) {
        const match = pathname.match(/(?:series|title)\/(\d+)/);
        return match ? match[1] : pathname.replace(/\//g, '');
    }
}
