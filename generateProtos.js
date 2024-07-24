import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import fs from 'fs/promises';
import path from 'path';
import inquirer from 'inquirer';
import * as tar from 'tar';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REFLECTION_PROTO_PATH = path.resolve(__dirname, './reflection.proto');

async function loadNetworkConfig(networkName) {
  const configPath = path.resolve(__dirname, 'network_configs', `${networkName}.yaml`);
  const configFile = await fs.readFile(configPath, 'utf8');
  return yaml.load(configFile);
}

async function promptUser() {
  const networks = await fs.readdir(path.resolve(__dirname, 'network_configs'));
  const networkChoices = networks.map(file => path.basename(file, '.yaml'));

  const questions = [
    {
      type: 'list',
      name: 'network',
      message: 'Select the network:',
      choices: networkChoices,
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

async function createReflectionClient(endpoint, useTLS) {
  const packageDefinition = protoLoader.loadSync(REFLECTION_PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
      oneofs: true,
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  const ReflectionService = protoDescriptor.cosmos.base.reflection.v1beta1.ReflectionService;

  return new ReflectionService(
    endpoint,
    useTLS ? grpc.credentials.createSsl() : grpc.credentials.createInsecure()
  );
}

async function listAllInterfaces(client) {
  return new Promise((resolve, reject) => {
    client.ListAllInterfaces({}, (error, response) => {
      if (error) reject(error);
      else resolve(response.interface_names);
    });
  });
}

async function listImplementations(client, interfaceName) {
  return new Promise((resolve, reject) => {
    client.ListImplementations({ interface_name: interfaceName }, (error, response) => {
      if (error) reject(error);
      else resolve(response.implementation_message_names);
    });
  });
}

async function getCustomDescriptor(client, method, request = {}) {
  return new Promise((resolve, reject) => {
    client[method](request, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function generateProtoFiles(client, networkConfig) {
  const protoDir = path.resolve(__dirname, 'generated_protos', networkConfig.name);
  await fs.mkdir(protoDir, { recursive: true });

  const interfaces = await listAllInterfaces(client);

  for (const interfaceName of interfaces) {
    const implementations = await listImplementations(client, interfaceName);
    await generateProtoFile(interfaceName, implementations, networkConfig, protoDir);
  }

  // Handle custom methods
  for (const customMethod of networkConfig.customMethods || []) {
    try {
      const descriptor = await getCustomDescriptor(client, customMethod);
      await generateCustomProtoFile(customMethod, descriptor, networkConfig, protoDir);
    } catch (error) {
      console.warn(`Warning: Custom method ${customMethod} failed:`, error.message);
    }
  }

  await generateCommonProtoFiles(protoDir);
}

async function generateProtoFile(interfaceName, implementations, networkConfig, protoDir) {
  const parts = interfaceName.split('.');
  const packageName = parts.slice(0, -1).join('.');
  const serviceName = parts[parts.length - 1];
  const fileName = `${serviceName.toLowerCase()}.proto`;
  const filePath = path.join(protoDir, ...packageName.split('.'), fileName);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let content = `syntax = "proto3";\n\n`;
  content += `package ${packageName};\n\n`;
  content += `import "google/api/annotations.proto";\n`;
  content += `import "gogoproto/gogo.proto";\n`;
  content += `import "cosmos/base/query/v1beta1/pagination.proto";\n\n`;
  content += `option go_package = "${networkConfig.goPackagePrefix}/${packageName}";\n\n`;

  content += `// ${serviceName} defines the gRPC queries for the ${parts.slice(0, -1).join('.')} module.\n`;
  content += `service ${serviceName} {\n`;

    for (const impl of implementations) {
      const methodName = impl.split('.').pop();
      content += `  rpc ${methodName}(${methodName}Request) returns (${methodName}Response) {\n`;
        content += `    option (google.api.http) = {\n      get: "/${packageName}/${serviceName.toLowerCase()}/${methodName.toLowerCase()}"\n    };\n`;
        content += `  }\n\n`;
    }

    content += `}\n\n`;

    for (const impl of implementations) {
      const methodName = impl.split('.').pop();
      content += `message ${methodName}Request {\n`;
        content += `  // Add fields here\n`;
        content += `}\n\n`;
        content += `message ${methodName}Response {\n`;
          content += `  // Add fields here\n`;
          content += `}\n\n`;
    }

    await fs.writeFile(filePath, content);
    console.log(`Generated proto file: ${filePath}`);
}

async function generateCustomProtoFile(methodName, descriptor, networkConfig, protoDir) {
  const fileName = `${methodName.toLowerCase()}_custom.proto`;
  const filePath = path.join(protoDir, 'custom', fileName);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let content = `syntax = "proto3";\n\n`;
  content += `package ${networkConfig.name}.custom;\n\n`;
  content += `import "google/api/annotations.proto";\n`;
  content += `import "gogoproto/gogo.proto";\n\n`;
  content += `option go_package = "${networkConfig.goPackagePrefix}/${networkConfig.name}/custom";\n\n`;

  content += `// ${methodName} is a custom method for the ${networkConfig.name} network.\n`;
  content += `service CustomService {\n`;
    content += `  rpc ${methodName}(${methodName}Request) returns (${methodName}Response) {\n`;
      content += `    option (google.api.http) = {\n      get: "/${networkConfig.name}/custom/${methodName.toLowerCase()}"\n    };\n`;
      content += `  }\n`;
      content += `}\n\n`;

      content += `message ${methodName}Request {\n`;
        content += `  // Add fields based on the descriptor\n`;
        for (const [key, value] of Object.entries(descriptor)) {
          if (typeof value === 'object') {
            content += `  // ${key}: Complex object, needs manual definition\n`;
          } else {
            content += `  ${typeof value} ${key} = 1; // Placeholder field number\n`;
          }
        }
        content += `}\n\n`;

        content += `message ${methodName}Response {\n`;
          content += `  // Add fields based on the expected response\n`;
          content += `  string result = 1; // Placeholder field\n`;
          content += `}\n`;

          await fs.writeFile(filePath, content);
          console.log(`Generated custom proto file: ${filePath}`);
}

async function generateCommonProtoFiles(protoDir) {
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

    'google/api/http.proto': `
    syntax = "proto3";

    package google.api;

    option go_package = "google.golang.org/genproto/googleapis/api/annotations;annotations";

    message Http {
      // Mapping rules for HTTP APIs.
      repeated HttpRule rules = 1;
    }

    // HttpRule defines the mapping of an RPC method to one or more HTTP REST API methods.
    message HttpRule {
      // Selects a method to which this rule applies.
      string selector = 1;

      // Specifies the HTTP method and path.
      oneof pattern {
        string get = 2;
        string put = 3;
        string post = 4;
        string delete = 5;
        string patch = 6;
        CustomHttpPattern custom = 8;
      }

      // The name of the request field whose value is mapped to the HTTP request body.
      string body = 7;

      // Additional HTTP bindings for the selector.
      repeated HttpRule additional_bindings = 11;
    }

    // A custom pattern is used for defining custom HTTP verb and path.
    message CustomHttpPattern {
      string kind = 1;
      string path = 2;
    }
    `.trim(),

    'gogoproto/gogo.proto': `
    syntax = "proto2";
    package gogoproto;

    import "google/protobuf/descriptor.proto";

    option go_package = "github.com/gogo/protobuf/gogoproto";

    extend google.protobuf.FieldOptions {
      optional bool nullable = 65001;
      optional bool embed = 65002;
      optional string customtype = 65003;
      optional bool customname = 65004;
      optional string jsontag = 65005;
      optional string moretags = 65006;
      optional string casttype = 65007;
      optional string castkey = 65008;
      optional string castvalue = 65009;
    }

    extend google.protobuf.MessageOptions {
      optional bool goproto_getters = 64001;
      optional bool goproto_stringer = 64003;
      optional bool verbose_equal = 64004;
      optional bool face = 64005;
      optional bool gostring = 64006;
      optional bool populate = 64007;
      optional bool unsafeunmarshaler = 64009;
      optional bool unsafemarshaler = 64010;
      optional bool stabilemarshaler = 64011;
      optional bool sizer = 64012;
      optional bool protosizer = 64013;
      optional bool equal = 64014;
      optional bool description = 64015;
      optional bool testgen = 64016;
      optional bool benchgen = 64017;
      optional bool marshaler = 64018;
      optional bool unmarshaler = 64019;
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
    const filePath = path.join(protoDir, file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    console.log(`Generated common proto file: ${filePath}`);
  }
}
async function generateTarball(networkName) {
  const protoDir = path.resolve(__dirname, 'generated_protos', networkName);
  const tarPath = path.resolve(__dirname, `${networkName}_protos.tar.gz`);
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
  const { network, generateTar } = await promptUser();
  const networkConfig = await loadNetworkConfig(network);

  const client = await createReflectionClient(networkConfig.endpoint, networkConfig.useTLS);

  try {
    await generateProtoFiles(client, networkConfig);

    if (generateTar) {
      await generateTarball(networkConfig.name);
    }
  } catch (error) {
    console.error('Error generating proto files:', error);
  } finally {
    client.close();
  }
}

main();
