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

const REFLECTION_PROTO_PATH = path.resolve(__dirname, './reflection.proto');

const packageDefinition = protoLoader.loadSync(REFLECTION_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const ReflectionService = protoDescriptor.grpc.reflection.v1alpha.ServerReflection;

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

async function getServiceList(client) {
  return new Promise((resolve, reject) => {
    const call = client.ServerReflectionInfo();
    call.write({ list_services: '' });
    call.on('data', (response) => {
      if (response.list_services_response) {
        resolve(response.list_services_response.service);
      }
    });
    call.on('error', reject);
    call.end();
  });
}

async function getServiceDescriptor(client, serviceName) {
  return new Promise((resolve, reject) => {
    const call = client.ServerReflectionInfo();
    call.write({ file_containing_symbol: serviceName });
    call.on('data', (response) => {
      if (response.file_descriptor_response) {
        resolve(response.file_descriptor_response.file_descriptor_proto);
      }
    });
    call.on('error', reject);
    call.end();
  });
}

function parseFileDescriptor(fileDescriptorProto) {
  const FileDescriptorProto = protoDescriptor.google.protobuf.FileDescriptorProto;
  const descriptor = FileDescriptorProto.decode(Buffer.from(fileDescriptorProto[0], 'base64'));
  return descriptor;
}

async function generateProtoFiles(client) {
  const protoDir = path.resolve(__dirname, 'generated_protos');
  await fs.mkdir(protoDir, { recursive: true });

  const services = await getServiceList(client);
  
  for (const service of services) {
    const fileDescriptorProto = await getServiceDescriptor(client, service.name);
    const descriptor = parseFileDescriptor(fileDescriptorProto);
    await generateProtoFile(descriptor, service.name);
  }

  await generateCommonProtoFiles();
}

async function generateProtoFile(descriptor, serviceName) {
  const packageName = descriptor.package;
  const fileName = serviceName.split('.').pop().toLowerCase() + '.proto';
  const dirPath = path.resolve(__dirname, 'generated_protos', ...packageName.split('.'));
  
  await fs.mkdir(dirPath, { recursive: true });
  
  let content = `syntax = "proto3";\n\n`;
  content += `package ${packageName};\n\n`;
  content += `import "google/api/annotations.proto";\n`;
  content += `import "gogoproto/gogo.proto";\n`;
  content += `import "cosmos/base/query/v1beta1/pagination.proto";\n\n`;
  content += `option go_package = "github.com/cosmos/cosmos-sdk/${packageName}";\n\n`;
  
  // Add service definition
  const service = descriptor.service.find(s => s.name === serviceName.split('.').pop());
  if (service) {
    content += `// ${service.name} defines the gRPC queries for the ${packageName} module.\n`;
    content += `service ${service.name} {\n`;
    for (const method of service.method) {
      content += `  rpc ${method.name} (${method.input_type.split('.').pop()}) returns (${method.output_type.split('.').pop()}) {\n`;
      content += `    option (google.api.http) = {\n      // HTTP binding to be filled\n    };\n`;
      content += `  }\n\n`;
    }
    content += `}\n\n`;
  }

  // Add message definitions
  for (const message of descriptor.message_type) {
    content += `message ${message.name} {\n`;
    for (const [index, field] of message.field.entries()) {
      const fieldType = field.type_name ? field.type_name.split('.').pop() : field.type.toLowerCase();
      content += `  ${fieldType} ${field.name} = ${index + 1}`;
      if (field.options) {
        const options = [];
        if (field.options.deprecated) options.push('deprecated = true');
        if (field.options['.gogoproto.nullable'] === false) options.push('(gogoproto.nullable) = false');
        if (options.length > 0) {
          content += ` [${options.join(', ')}]`;
        }
      }
      content += `;\n`;
    }
    content += `}\n\n`;
  }
  
  const filePath = path.join(dirPath, fileName);
  await fs.writeFile(filePath, content);
  console.log(`Generated proto file: ${filePath}`);
}

async function generateCommonProtoFiles() {
  const commonProtos = {
    'google/api/annotations.proto': `
syntax = "proto3";

package google.api;

import "google/api/http.proto";
import "google/protobuf/descriptor.proto";

option go_package = "google.golang.org/genproto/googleapis/api/annotations;annotations";

extend google.protobuf.MethodOptions {
  // See HttpRule for details.
  HttpRule http = 72295728;
}
    `.trim(),
    
    'cosmos/base/query/v1beta1/pagination.proto': `
syntax = "proto3";

package cosmos.base.query.v1beta1;

option go_package = "github.com/cosmos/cosmos-sdk/types/query";

// PageRequest is to be embedded in gRPC request messages for efficient pagination.
message PageRequest {
  // key is a value returned in PageResponse.next_key to begin querying the next page.
  bytes key = 1;

  // offset is a numeric offset that can be used when key is unavailable.
  uint64 offset = 2;

  // limit is the total number of results to be returned in the result page.
  uint64 limit = 3;

  // count_total is set to true to indicate that the result set should include a count of the total number of items available.
  bool count_total = 4;

  // reverse is set to true if results are to be returned in the descending order.
  bool reverse = 5;
}

// PageResponse is to be embedded in gRPC response messages where the corresponding request message has used PageRequest.
message PageResponse {
  // next_key is the key to be passed to PageRequest.key to query the next page.
  bytes next_key = 1;

  // total is total number of results available if PageRequest.count_total was set, its value is undefined otherwise.
  uint64 total = 2;
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
