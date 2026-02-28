import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import archiver from 'archiver'

// ─── Zip Utility ──────────────────────────────────────────────────────────────

/**
 * Creates a ZIP archive of the given directory and writes it to a temp file.
 * Returns the path to the temp zip file. The caller is responsible for
 * deleting the file after use.
 */
export async function zipDirectory(dirPath: string): Promise<string> {
  const dirName = path.basename(dirPath)
  const tempFile = path.join(os.tmpdir(), `${dirName}-${Date.now()}.zip`)

  return new Promise<string>((resolve, reject) => {
    const output = fs.createWriteStream(tempFile)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => resolve(tempFile))
    archive.on('error', reject)

    archive.pipe(output)
    archive.directory(dirPath, false)
    void archive.finalize()
  })
}
