import * as AWS from "aws-sdk";
import { Key } from "aws-sdk/clients/dynamodb";

const client = new AWS.DynamoDB.DocumentClient();

function chunk<T>(input: T[], size: number): T[][] {
  return input.reduce((arr, item, idx) => {
    return idx % size === 0 ? [...arr, [item]] : [...arr.slice(0, -1), [...arr.slice(-1)[0], item]];
  }, []);
}

export async function batchGet<T>(table: string, keys: Key[], batchSize = 50): Promise<T[]> {
  return (
    await Promise.all(
      chunk(keys, batchSize).map(async (Keys) => {
        const params = {
          RequestItems: {
            [table]: {
              Keys,
            },
          },
        };
        const { Responses: res } = await client.batchGet(params).promise();
        if (!res) return [];
        return res[table];
      })
    )
  ).flat() as T[];
}

export async function batchSet<T>(table: string, items: T[], batchSize = 5): Promise<void> {
  await Promise.all(
    chunk(items, batchSize).map(async (chunk) => {
      const params = {
        RequestItems: {
          [table]: chunk.map((Item) => ({
            PutRequest: { Item },
          })),
        },
      };
      try {
        await client.batchWrite(params).promise();
      } catch (err) {
        console.log(JSON.stringify(chunk), err);
      }
    })
  );
}

export async function scan<T>(table: string): Promise<T[]> {
  const { Items: items } = await client
    .scan({
      TableName: table,
    })
    .promise();
  return items as T[];
}

export async function remove(table: string, key: Key): Promise<void> {
  await client.delete({ Key: key, TableName: table }).promise();
}
