import mongoose from 'mongoose'

const connectDB = async (): Promise<void> => {
  const uri = process.env.MONGODB_URI

  if (!uri) {
    throw new Error('MONGODB_URI is not defined in environment variables')
  }

  try {
    const conn = await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB_NAME || 'buildflow',
    })

    console.log(`MongoDB connected: ${conn.connection.host}`)

    mongoose.connection.on('error', (err) => {
      console.error(`MongoDB connection error: ${err}`)
    })

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected. Attempting to reconnect...')
    })
  } catch (err) {
    console.error('MongoDB initial connection failed:', err)
    process.exit(1)
  }
}

export default connectDB
