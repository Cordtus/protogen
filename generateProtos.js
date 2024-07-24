import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import fs from 'fs/promises';
import path from 'path';
import inquirer from 'inquirer';
import * as tar from 'tar';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROTO_PATH = path.resolve(__dirname, './reflection.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const ReflectionService = protoDescriptor.cosmos.base.reflection.v1beta1.ReflectionService;

async function promptUser() {
  const questions = [
    {
      type: 'input',
      name: 'endpoint',
      message: 'Enter the gRPC endpoint:',
      default: 'sei.grpc.kjnodes.com:443',
    },
    {
      type: 'list',
      name: 'useTLS',
      message: 'Select connection type:',
      choices: ['plaintext', 'TLS'],
      default: 'TLS',
    },
    {
      type: 'confirm',
      name: 'generateTar',
      message: 'Do you want to generate a .tar.gz file for the .proto files?',
      default: true,
    },
  ];

  return inquirer.prompt(questions);
}

async function callMethod(client, methodName, request = {}) {
  return new Promise((resolve, reject) => {
    if (typeof client[methodName] !== 'function') {
      reject(new Error(`Method ${methodName} not found`));
      return;
    }
    client[methodName](request, (error, response) => {
      if (error) {
        console.warn(`Warning: ${methodName} failed:`, error.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

async function generateProtoFiles(client) {
  const protoDir = path.resolve(__dirname, 'generated_protos');
  await fs.mkdir(protoDir, { recursive: true });

  const interfaces = await callMethod(client, 'ListAllInterfaces');
  if (interfaces && interfaces.interface_names) {
    for (const interfaceName of interfaces.interface_names) {
      const implementations = await callMethod(client, 'ListImplementations', { interface_name: interfaceName });
      if (implementations && implementations.implementation_message_names) {
        await generateProtoFile(interfaceName, implementations.implementation_message_names);
      }
    }
  }

  await generateCommonProtoFiles();
}

async function generateProtoFile(interfaceName, implementations) {
  const parts = interfaceName.split('.');
  const packageName = parts.slice(0, -1).join('.');
  const serviceName = parts[parts.length - 1];
  const fileName = `${serviceName.toLowerCase()}.proto`;
  const dirPath = path.resolve(__dirname, 'generated_protos', ...parts.slice(0, -1));
  
  await fs.mkdir(dirPath, { recursive: true });
  
  let content = `syntax = "proto3";\n\n`;
  content += `package ${packageName};\n\n`;
  content += `import "google/protobuf/any.proto";\n\n`;
  content += `option go_package = "github.com/cosmos/cosmos-sdk/${packageName}";\n\n`;
  
  content += `// ${serviceName} defines the gRPC service for the ${parts.slice(0, -1).join(' ')} module.\n`;
  content += `service ${serviceName} {\n`;
  
  for (const impl of implementations) {
    const methodName = impl.split('.').pop();
    content += `  // ${methodName} defines a method for the ${serviceName} service.\n`;
    content += `  rpc ${methodName}(${methodName}Request) returns (${methodName}Response);\n\n`;
  }
  
  content += `}\n\n`;
  
  for (const impl of implementations) {
    const methodName = impl.split('.').pop();
    content += `// ${methodName}Request defines the request structure for the ${methodName} gRPC method.\n`;
    content += `message ${methodName}Request {}\n\n`;
    content += `// ${methodName}Response defines the response structure for the ${methodName} gRPC method.\n`;
    content += `message ${methodName}Response {\n`;
    content += `  // response field placeholder\n`;
    content += `  google.protobuf.Any result = 1;\n`;
    content += `}\n\n`;
  }
  
  const filePath = path.join(dirPath, fileName);
  await fs.writeFile(filePath, content);
  console.log(`Generated proto file: ${filePath}`);
}

async function generateCommonProtoFiles() {
  const commonProtos = {
    'google/protobuf/any.proto': `
syntax = "proto3";

package google.protobuf;

option go_package = "github.com/golang/protobuf/ptypes/any";

// Any contains an arbitrary serialized protocol buffer message along with a
// URL that describes the type of the serialized message.
message Any {
  // A URL/resource name that uniquely identifies the type of the serialized
  // protocol buffer message.
  string type_url = 1;

  // Must be a valid serialized protocol buffer of the above specified type.
  bytes value = 2;
}
    `.trim(),
    
    'cosmos/base/v1beta1/coin.proto': `
syntax = "proto3";

package cosmos.base.v1beta1;

option go_package = "github.com/cosmos/cosmos-sdk/types";

// Coin defines a token with a denomination and an amount.
message Coin {
  string denom = 1;
  string amount = 2;
}
    `.trim(),
  };

  for (const [file, content] of Object.entries(commonProtos)) {
    const filePath = path.resolve(__dirname, 'generated_protos', file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    console.log(`Generated common proto file: ${filePath}`);
  }
}

async function generateTarball() {
  const protoDir = path.resolve(__dirname, 'generated_protos');
  const tarPath = path.resolve(__dirname, 'generated_protos.tar.gz');
  await tar.c(
    {
      gzip: true,
      file: tarPath,
      cwd: protoDir,
    },
    ['.']
  );
  console.log(`Generated tarball: ${tarPath}`);
}

async function main() {
  const { endpoint, useTLS, generateTar } = await promptUser();
  const client = new ReflectionService(
    endpoint,
    useTLS === 'TLS' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure()
  );

  try {
    await generateProtoFiles(client);

    if (generateTar) {
      await generateTarball();
    }
  } catch (error) {
    console.error('Error generating proto files:', error);
  } finally {
    client.close();
  }
}

main();
