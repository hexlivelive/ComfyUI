import axios from "axios";
import * as fs from "fs";
import mongoose, { Model, Types } from "mongoose";
import { MongoClient, Db } from "mongodb"; // MongoDB client
import FormData from "form-data";
const mongoUrl =
  "mongodb+srv://superuser:81j704oSKVwz2G39@db-mongodb-nyc3-11975-18134e1c.mongo.ondigitalocean.com/AIv1?tls=true&authSource=admin&replicaSet=db-mongodb-nyc3-11975"; // Change to your MongoDB URI
const dbName = "AIv1";

let db: any;

async function connectToMongo() {
  const client = new MongoClient(mongoUrl);
  await client.connect();
  console.log("Connected to MongoDB");
  db = client.db(dbName);
}

export default class CloudflareImageService {
  private cloudflareImageGroupModel: any;
  private cloudflareImageModel: any;

  constructor(db: Db) {
    this.cloudflareImageGroupModel = db.collection("cloudflare_image_group");
    this.cloudflareImageModel = db.collection("cloudflare_image");
  }

  public async uploadImages(
    buffers: Buffer[],
    filenames: string[],
    imageGroupName: string,
    imageGroupDescription: string,
    userId: mongoose.Types.ObjectId
  ) {
    for (let i = 0; i < buffers.length; i++) {
      await this.uploadImage({
        buffer: buffers[i],
        filename: filenames[i],
        imageGroupName,
        imageGroupDescription,
        userId,
      });
    }
  }

  // Function to upload an image to Cloudflare
  public async uploadImage({
    buffer,
    filename,
    imageGroupName,
    imageGroupDescription,
    userId,
    isPublic = false,
  }: {
    buffer: Buffer;
    filename: string;
    imageGroupName: string;
    imageGroupDescription: string;
    userId: mongoose.Types.ObjectId;
    isPublic?: boolean;
  }): Promise<any> {
    const formData = new FormData();

    formData.append("file", buffer, filename);

    const apiToken = "pSHn_IURenndTFhtEtSDqR-42VgLfL9ZQAWrmEvW";

    const imageUploadUrl =
      "https://api.cloudflare.com/client/v4/accounts/19044b388e1482fed65f4645aecbdc8e/images/v1";
    let imageGroup;
    try {
      const response = await axios.post(imageUploadUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${apiToken}`,
        },
      });

      if (response.status === 200) {
        console.log("Image uploaded successfully");
        imageGroup = await this.doesImageGroupExists(userId, imageGroupName);

        const imageId = response.data.result.id;

        if (!imageGroup) {
          const createdResult = await this.cloudflareImageGroupModel.insertOne({
            _id: new Types.ObjectId(),
            name: imageGroupName,
            description: imageGroupDescription,
            userId: userId,
            urls: [this.getImageUrl(imageId)],
            imageIds: [imageId],
            updatedAt: new Date(),
            createdAt: new Date(),
          });

          imageGroup = await this.cloudflareImageGroupModel.findOne(
            createdResult.insertedId
          );
        } else {
          // Add the image to the image group
          imageGroup.imageIds.push(imageId);
          imageGroup.urls.push(this.getImageUrl(imageId));

          await this.cloudflareImageGroupModel.updateOne(
            { _id: imageGroup._id },
            {
              $push: {
                imageIds: imageId,
                urls: this.getImageUrl(imageId),
              },
            },
            {
              $set: {
                updatedAt: new Date(),
              },
            }
          );
        }

        await this.cloudflareImageModel.insertOne({
          _id: new Types.ObjectId(),
          imageId: imageId,
          filename: response.data.result.filename,
          userId: userId,
          url: this.getImageUrl(imageId),
          imageGroupId: imageGroup._id,
          uploadedAt: new Date(response.data.result.uploaded),
          isPublic: isPublic,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        console.error("Image upload failed");
        throw new Error("Image upload failed");
      }

      return imageGroup;
    } catch (error) {
      console.error("Error uploading image:", error);
      throw error;
    }
  }

  /**
   * update a image group
   *
   * @param imageGroupId
   * @param imageGroupName
   * @param imageGroupDescription
   * @returns
   */
  public async updateImageGroup(
    imageGroupId: mongoose.Types.ObjectId,
    imageGroupName: string,
    imageGroupDescription: string
  ) {
    return await this.cloudflareImageGroupModel.updateOne(
      { _id: imageGroupId },
      {
        $set: {
          imageGroupName,
          imageGroupDescription,
        },
      }
    );
  }

  public async doesImageGroupExists(
    userId: mongoose.Types.ObjectId,
    imageGroupName: string
  ): Promise<any> {
    return await this.cloudflareImageGroupModel.findOne({
      userId: userId,
      name: imageGroupName,
    });
  }

  public async getImageGroupById(
    imageGroupId: mongoose.Types.ObjectId
  ): Promise<any> {
    const imageGroup = await this.cloudflareImageGroupModel.findById(
      imageGroupId
    );
    return imageGroup;
  }

  public async getImageById(imageId: string): Promise<any> {
    return await this.cloudflareImageModel.findOne({ imageId: imageId });
  }

  /**
   * Get the image url
   *
   * @param imageId
   * @returns
   */
  public getImageUrl(imageId: string, variantName: string = "public") {
    const accountHash = "hUZkA7QQ8hV1UxYbRNOnKw";
    return `https://imagedelivery.net/${accountHash}/${imageId}/${variantName}&q=100`;
  }
}
