import * as ffmpeg from 'fluent-ffmpeg'
import * as fs from 'fs'
import * as path from 'path'
import axios, { AxiosResponse } from 'axios'
import cheerio, { CheerioAPI } from 'cheerio'
import * as flac from 'flac-metadata'
import * as images from 'images'
import { pipeline } from 'stream/promises'

interface Tag {
  // Track name
  title: string,
  // Track artist
  artist: string,
  // Track genre
  genre: string,
  // Track album
  album: string,
  // Release date
  date: string,
  // Track cover art
  APIC: ArrayBuffer|null,
}

const convertFlac = (file: string): Promise<string|undefined> => {
  return new Promise((resolve, reject) => {
    console.log('Converting ' + file + ' to flac...')
    const wavpath = path.join(process.argv[2], file)
    const flacpath = wavpath.replace('.wav', '.flac')
    ffmpeg(wavpath)
      .format('wav')
      .toFormat('flac')
      .on('error', (err: Error): void => {
        reject(new Error('An error occurred: ' + err.message))
      })
      .on('end', () => {
        resolve(flacpath)
      })
      .save(flacpath)
  })
}

const fetchTags = async (matches: string[]): Promise<void> => {
  try {
    const tag: Tag = {
      title: matches[2].replace(/(.+)_(\([^_]+\))$/g, '$1 $2'),
      album: '',
      artist: '',
      genre: '',
      date: '',
      APIC: null
    }
    console.log(`Fetching tags for ${matches[2]}...`)
    const trackQuery: string = matches[2].replace(/_\([^_]+\)$/g, '+').replace(/\(|\)|\.|\s/g, '-').toLowerCase()
    // Search track by track id and name
    let result: AxiosResponse = await axios.get(`https://www.beatport.com/track/${trackQuery}/${matches[1]}`)
    let $: CheerioAPI = cheerio.load(result.data)
    tag.genre = $('.interior-track-content-item.interior-track-genre .value').text().trim().split('|').map(s => s.trim()).join(', ')
    const artists = []
    for (let i = 0; i < $('.interior-track-artists .value').length; i++) {
      artists.push(...$('.interior-track-artists .value').eq(i).text().replace(/\n/g, '').split(',').map(s => s.trim()))
    }
    tag.artist = artists.join(', ')
    tag.date = new Date($('.interior-track-content-item.interior-track-released .value').text().trim()).getFullYear().toString()
    // Get cover buffer
    const coverURL = $('.interior-track-release-artwork').attr('src')?.replace('500x500', '1400x1400') || ''
    if (coverURL.length > 0) {
      result = await axios.get(coverURL, { responseType: 'arraybuffer' })
      // Convert webp to jpg
      tag.APIC = await images(result.data).encode('jpg')
    }
    // Get release album name
    const releaseURL: string = $('.interior-track-release-artwork-link').attr('href') || ''
    if (releaseURL.length > 0) {
      result = await axios.get('https://www.beatport.com' + releaseURL)
      $ = cheerio.load(result.data)
      tag.album = $('.interior-release-chart-content h1').text().trim()
    }
    const filenameOld = matches[1] + '_' + matches[2] + '.flac'
    const filenameNew = `${tag.artist} - ${tag.title}.flac`
    const filepath: string = path.join(process.argv[2], filenameOld)
    const outputFolder = path.join(process.argv[2], 'output')
    const outputpath = path.join(outputFolder, filenameNew)
    fs.existsSync(outputFolder) || fs.mkdirSync(outputFolder)
    const flacReader = fs.createReadStream(filepath)
    const flacWriter = fs.createWriteStream(outputpath)
    const processor = new flac.Processor()
    const comments = [
      'ARTIST=' + tag.artist,
      'TITLE=' + tag.title,
      'ALBUM=' + tag.album,
      'GENRE=' + tag.genre,
      'DATE=' + tag.date
    ]
    processor.on('preprocess', function (mdb) {
      if (mdb.type === flac.Processor.MDB_TYPE_VORBIS_COMMENT) {
        mdb.remove()
      }
      if (mdb.type === flac.Processor.MDB_TYPE_PICTURE) {
        mdb.remove()
      }
      if (mdb.isLast) {
        mdb.isLast = false
        const mdbVorbis = flac.data.MetaDataBlockVorbisComment.create(!tag.APIC, '', comments)
        this.push(mdbVorbis.publish())
        if (tag.APIC) {
          // isLast, pictureType, mimeType, description, width, height, bitsPerPixel, colors, pictureData
          const mdbPicture = flac.data.MetaDataBlockPicture.create(true, 3, 'image/jpeg', '', 1400, 1400, 24, 0, tag.APIC)
          this.push(mdbPicture.publish())
        }
      }
    })
    await pipeline(flacReader, processor, flacWriter)
    fs.unlinkSync(filepath)
  } catch (error) {
    const err = error as Error
    console.log(err.message)
  }
}

const main = async (): Promise<void> => {
  const files = fs.readdirSync(process.argv[2])
  for (const file of files) {
    const matches = Array.from(file.matchAll(/(\d+)_(.*)\.wav$/gm))
    if (matches.length > 0) {
      console.log('Found ' + file)
      try {
        await convertFlac(file)
        await fetchTags(matches[0])
      } catch (error) {
        const err = error as Error
        console.log('Error: ' + err.message)
      }
    }
  }
}

main()
