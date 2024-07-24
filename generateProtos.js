import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import * as tar from 'tar';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Convert __dirname to work with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROTO_PATH = path.resolve(__dirname, './reflection.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const reflectionService = protoDescriptor.cosmos.base.reflection.v1beta1.ReflectionService;

async function promptUser() {
  const questions = [
    {
      type: 'input',
      name: 'endpoint',
      message: 'Enter the gRPC endpoint:',
    },
    {
      type: 'list',
      name: 'useTLS',
      message: 'Select connection type:',
      choices: ['plaintext', 'TLS'],
    },
    {
      type: 'confirm',
      name: 'generateTar',
      message: 'Do you want to generate a .tar.gz file for the .proto files?',
      default: true,
    }
  ];

  const answers = await inquirer.prompt(questions);
  return answers;
}

async function queryReflectionService(endpoint, useTLS) {
  const credentials = useTLS === 'TLS' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  const client = new reflectionService(endpoint, credentials);

  const methods = [
    { name: 'ListAllInterfaces', request: {}, responseKey: 'listAllInterfaces' },
    { name: 'ListImplementations', requestKey: 'interface_name', responseKey: 'implementations', iterate: true },
    { name: 'GetAuthnDescriptor', request: {}, responseKey: 'getAuthnDescriptor' },
    { name: 'GetChainDescriptor', request: {}, responseKey: 'getChainDescriptor' },
    { name: 'GetCodecDescriptor', request: {}, responseKey: 'getCodecDescriptor' },
    { name: 'GetConfigurationDescriptor', request: {}, responseKey: 'getConfigurationDescriptor' },
    { name: 'GetQueryServicesDescriptor', request: {}, responseKey: 'getQueryServicesDescriptor' },
    { name: 'GetTxDescriptor', request: {}, responseKey: 'getTxDescriptor' }
  ];

  const descriptors = {};
  const missingMethods = [];

  for (const method of methods) {
    try {
      if (method.iterate) {
        const listAllInterfaces = await new Promise((resolve, reject) => {
          client.ListAllInterfaces({}, (error, response) => {
            if (error) reject(error);
            else resolve(response);
          });
        });

        descriptors[method.responseKey] = {};
        for (const iface of listAllInterfaces.interface_names) {
          const response = await new Promise((resolve, reject) => {
            client[method.name]({ [method.requestKey]: iface }, (error, response) => {
              if (error) reject(error);
              else resolve(response);
            });
          });
          descriptors[method.responseKey][iface] = response;
        }
      } else {
        const response = await new Promise((resolve, reject) => {
          client[method.name](method.request, (error, response) => {
            if (error) reject(error);
            else resolve(response);
          });
        });
        descriptors[method.responseKey] = response;
      }
    } catch (error) {
      if (error.code === 12) { // UNIMPLEMENTED
        missingMethods.push(method.name);
      } else {
        console.error(`Error querying ${method.name}:`, error);
      }
    }
  }

  console.log('Descriptors:', descriptors);
  generateProtoFiles(descriptors);

  if (missingMethods.length > 0) {
    console.log('Missing methods:', missingMethods);
  }

  return missingMethods;
}

function generateProtoFiles(descriptors) {
  const protoDir = path.resolve(__dirname, 'generated_protos');
  if (!fs.existsSync(protoDir)) {
    fs.mkdirSync(protoDir);
  }

  Object.keys(descriptors).forEach((key) => {
    const dirPath = path.resolve(protoDir, key);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath);
    }

    const descriptor = descriptors[key];
    if (typeof descriptor === 'object' && !Array.isArray(descriptor)) {
      Object.keys(descriptor).forEach((subKey) => {
        const filePath = path.resolve(dirPath, `${subKey}.proto`);
        const content = generateProtoContent(key, descriptor[subKey]);
        fs.writeFileSync(filePath, content);
        console.log(`Generated proto file: ${filePath}`);
      });
    } else {
      const filePath = path.resolve(dirPath, `${key}.proto`);
      const content = generateProtoContent(key, descriptor);
      fs.writeFileSync(filePath, content);
      console.log(`Generated proto file: ${filePath}`);
    }
  });
}

function generateProtoContent(type, descriptor) {
  const content = `
    syntax = "proto3";
    package cosmos.base.reflection.v1beta1;

    // Auto-generated proto file for ${type}
    message ${type} {
      ${Object.entries(descriptor)
        .map(([key, value], index) => `repeated ${typeof value === 'object' ? 'message' : typeof value} ${key} = ${index + 1};`)
        .join('\n      ')}
    }
  `;
  return content;
}

async function generateTarball() {
  const protoDir = path.resolve(__dirname, 'generated_protos');
  const tarPath = path.resolve(__dirname, 'generated_protos.tar.gz');
  await tar.c(
    {
      gzip: true,
      file: tarPath,
      cwd: protoDir
    },
    ['.']
  );
  console.log(`Generated tarball: ${tarPath}`);
}

async function main() {
  const { endpoint, useTLS, generateTar } = await promptUser();
  const missingMethods = await queryReflectionService(endpoint, useTLS);
  if (generateTar) {
    await generateTarball();
  }
  console.log('Missing methods:', missingMethods);
}

main();
