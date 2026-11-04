import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { QueueItem } from './queue'

interface PollWorkerDB extends DBSchema {
  items: { key: string; value: QueueItem }
  photos: { key: string; value: Blob }
}

let dbPromise: Promise<IDBPDatabase<PollWorkerDB>> | null = null

/** IndexedDB survives closing the tab, reloading and losing the network (RT-6). */
function db(): Promise<IDBPDatabase<PollWorkerDB>> {
  dbPromise ??= openDB<PollWorkerDB>('elections-poll-worker', 1, {
    upgrade(database) {
      database.createObjectStore('items', { keyPath: 'key' })
      database.createObjectStore('photos')
    },
  })
  return dbPromise
}

export async function allItems(): Promise<QueueItem[]> {
  return (await db()).getAll('items')
}

export async function putItem(item: QueueItem): Promise<void> {
  await (await db()).put('items', item)
}

/** The item (with its idem) and the photo are stored together BEFORE the first send. */
export async function putItemWithPhoto(item: QueueItem, photo: Blob | null): Promise<void> {
  const tx = (await db()).transaction(['items', 'photos'], 'readwrite')
  await tx.objectStore('items').put(item)
  if (photo) await tx.objectStore('photos').put(photo, item.key)
  await tx.done
}

export async function getPhoto(key: string): Promise<Blob | undefined> {
  return (await db()).get('photos', key)
}
