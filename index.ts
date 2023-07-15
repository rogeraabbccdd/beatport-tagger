import * as ffmpeg from 'fluent-ffmpeg'
import * as fs from 'fs'
import * as path from 'path'
import axios, { AxiosResponse } from 'axios'
import * as flac from 'flac-metadata'
import * as images from 'images'
import { pipeline } from 'stream/promises'
import * as truncate from 'truncate-utf8-bytes'

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

const illegalRe = /[/?<>\\:*|"]/g
const controlRe = /[\x00-\x1f\x80-\x9f]/g
const reservedRe = /^\.+$/
const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const windowsTrailingRe = /[. ]+$/

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
    // Search track by track id and name
    console.log(`https://api.beatport.com/v4/catalog/tracks/${matches[1]}`)
    let result: AxiosResponse = await axios.get(`https://api.beatport.com/v4/catalog/tracks/${matches[1]}`, {
      headers: {
        origin: 'https://www.beatport.com',
        Authorization: 'Bearer xxxxx'
      }
    })
    tag.genre = result.data.genre.name
    const artists = []
    for (let i = 0; i < result.data.artists.length; i++) {
      artists.push(result.data.artists[i].name)
    }
    tag.artist = artists.join(', ')
    tag.date = result.data.publish_date.split('-')[0]
    tag.album = result.data.release.name
    // Get cover buffer
    const coverURL = result.data.release.image.uri
    if (coverURL.length > 0) {
      result = await axios.get(coverURL, { responseType: 'arraybuffer' })
      // Convert webp to jpg
      tag.APIC = await images(result.data).encode('jpg')
      console.log(coverURL)
    }

    const filenameOld = matches[1] + '_' + matches[2] + '.flac'
    let filenameNew = `${tag.artist} - ${tag.title}.flac`
      .replace(illegalRe, '')
      .replace(controlRe, '')
      .replace(reservedRe, '')
      .replace(windowsReservedRe, '')
      .replace(windowsTrailingRe, '')
    filenameNew = truncate(filenameNew, filenameNew.length)
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
    console.log(err)
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
