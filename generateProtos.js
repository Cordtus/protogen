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
const PROTO_INCLUDE_DIRS = [
    path.resolve(__dirname, 'proto_includes/googleapis'),
    path.resolve(__dirname, 'proto_includes/protobuf/src'),
    path.resolve(__dirname, 'proto_includes/cosmos-sdk/proto'),
    path.resolve(__dirname, 'proto_includes/cosmos-sdk/third_party/proto'),
];

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

async function createReflectionClients(endpoint, useTLS) {
    const packageDefinition = protoLoader.loadSync(REFLECTION_PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
            oneofs: true,
            includeDirs: PROTO_INCLUDE_DIRS,
    });
    
    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    const credentials = useTLS ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    
    return {
        grpcReflection: new protoDescriptor.grpc.reflection.v1alpha.ServerReflection(endpoint, credentials),
        cosmosReflection: new protoDescriptor.cosmos.base.reflection.v1beta1.ReflectionService(endpoint, credentials),
        cosmosReflectionV2: new protoDescriptor.cosmos.base.reflection.v2alpha1.ReflectionService(endpoint, credentials)
    };
}

async function getServiceList(client) {
    return new Promise((resolve, reject) => {
        const call = client.ServerReflectionInfo();
        call.write({ list_services: 'list_services' });
        call.on('data', (response) => {
            if (response.list_services_response) {
                resolve(response.list_services_response.service);
            }
        });
        call.on('error', reject);
        call.end();
    });
}

async function getFileDescriptor(client, symbol) {
    return new Promise((resolve, reject) => {
        const call = client.ServerReflectionInfo();
        call.write({ file_containing_symbol: symbol });
        call.on('data', (response) => {
            if (response.file_descriptor_response) {
                resolve(response.file_descriptor_response.file_descriptor_proto);
            }
        });
        call.on('error', reject);
        call.end();
    });
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

async function getReflectionV2Descriptor(client, method) {
    return new Promise((resolve, reject) => {
        client[method]({}, (error, response) => {
            if (error) reject(error);
            else resolve(response);
        });
    });
}

function parseFileDescriptor(fileDescriptorProto) {
    const FileDescriptorProto = protoLoader.loadSync(REFLECTION_PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
            oneofs: true,
            includeDirs: PROTO_INCLUDE_DIRS,
    }).google.protobuf.FileDescriptorProto;
    
    return FileDescriptorProto.decode(Buffer.from(fileDescriptorProto[0], 'base64'));
}

async function generateProtoFiles(clients) {
    const protoDir = path.resolve(__dirname, 'generated_protos');
    await fs.mkdir(protoDir, { recursive: true });
    
    // Standard gRPC reflection
    const services = await getServiceList(clients.grpcReflection);
    for (const service of services) {
        const fileDescriptorProto = await getFileDescriptor(clients.grpcReflection, service.name);
        const descriptor = parseFileDescriptor(fileDescriptorProto);
        await generateProtoFile(descriptor, service.name, protoDir);
    }
    
    // Cosmos SDK reflection v1beta1
    const interfaces = await listAllInterfaces(clients.cosmosReflection);
    for (const interfaceName of interfaces) {
        const implementations = await listImplementations(clients.cosmosReflection, interfaceName);
        await generateCosmosProtoFile(interfaceName, implementations, protoDir);
    }
    
    // Cosmos SDK reflection v2alpha1
    const v2Methods = [
        'GetAuthnDescriptor',
        'GetChainDescriptor',
        'GetCodecDescriptor',
        'GetConfigurationDescriptor',
        'GetQueryServicesDescriptor',
        'GetTxDescriptor'
    ];
    for (const method of v2Methods) {
        try {
            const descriptor = await getReflectionV2Descriptor(clients.cosmosReflectionV2, method);
            await generateReflectionV2ProtoFile(method, descriptor, protoDir);
        } catch (error) {
            console.warn(`Warning: ${method} failed:`, error.message);
        }
    }
}

async function generateProtoFile(descriptor, serviceName, protoDir) {
    const packageName = descriptor.package;
    const fileName = serviceName.split('.').pop().toLowerCase() + '.proto';
    const filePath = path.join(protoDir, ...packageName.split('.'), fileName);
    
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
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
                    content += `    option (google.api.http) = {\n      get: "/${packageName}/${service.name.toLowerCase()}/${method.name.toLowerCase()}"\n    };\n`;
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
    
    await fs.writeFile(filePath, content);
    console.log(`Generated proto file: ${filePath}`);
}

async function generateCosmosProtoFile(interfaceName, implementations, protoDir) {
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
    content += `option go_package = "github.com/cosmos/cosmos-sdk/${packageName}";\n\n`;
    
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
                content += `  cosmos.base.query.v1beta1.PageRequest pagination = 1;\n`;
                content += `}\n\n`;
                content += `message ${methodName}Response {\n`;
                    content += `  cosmos.base.query.v1beta1.PageResponse pagination = 1;\n`;
                    content += `}\n\n`;
        }
        
        await fs.writeFile(filePath, content);
        console.log(`Generated Cosmos-specific proto file: ${filePath}`);
}

async function generateReflectionV2ProtoFile(method, descriptor, protoDir) {
    const fileName = `${method.toLowerCase()}.proto`;
    const filePath = path.join(protoDir, 'cosmos', 'base', 'reflection', 'v2alpha1', fileName);
    
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    let content = `syntax = "proto3";\n\n`;
    content += `package cosmos.base.reflection.v2alpha1;\n\n`;
    content += `import "google/api/annotations.proto";\n`;
    content += `import "gogoproto/gogo.proto";\n\n`;
    content += `option go_package = "github.com/cosmos/cosmos-sdk/server/grpc/reflection/v2alpha1";\n\n`;
    
    content += `// ${method} defines the gRPC query method for app reflection.\n`;
    content += `service ReflectionService {\n`;
        content += `  rpc ${method}(${method}Request) returns (${method}Response) {\n`;
            content += `    option (google.api.http) = {\n      get: "/cosmos/base/reflection/v2alpha1/${method.toLowerCase()}"\n    };\n`;
            content += `  }\n`;
            content += `}\n\n`;
            
            content += `message ${method}Request {}\n\n`;
            content += `message ${method}Response {\n`;
                
                // Recursively add fields from the descriptor
                function addFields(obj, indent = '') {
                    let fieldContent = '';
                    let fieldIndex = 1;
                    for (const [key, value] of Object.entries(obj)) {
                        if (typeof value === 'object' && value !== null) {
                            fieldContent += `${indent}message ${key} {\n`;
                                fieldContent += addFields(value, indent + '  ');
                                fieldContent += `${indent}}\n`;
                        } else {
                            const fieldType = typeof value === 'string' ? 'string' : 
                            typeof value === 'number' ? 'int64' :
                            typeof value === 'boolean' ? 'bool' : 'google.protobuf.Any';
                            fieldContent += `${indent}${fieldType} ${key} = ${fieldIndex++};\n`;
                        }
                    }
                    return fieldContent;
                }
                
                content += addFields(descriptor, '  ');
                content += `}\n`;
                
                await fs.writeFile(filePath, content);
                console.log(`Generated Reflection v2 proto file: ${filePath}`);
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
    const clients = await createReflectionClients(endpoint, useTLS === 'TLS');
    
    try {
        await generateProtoFiles(clients);
        
        if (generateTar) {
            await generateTarball();
        }
    } catch (error) {
        console.error('Error generating proto files:', error);
    } finally {
        Object.values(clients).forEach(client => client.close());
    }
}

main();
