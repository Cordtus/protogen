# Protogen

Protogen is a Node.js application that generates `.proto` files based on the descriptors provided by a gRPC reflection service. The generated `.proto` files can be exported as a `.tar.gz` archive for easy transport.

## Features

- Interactively query a gRPC reflection service to generate `.proto` files.
- Handles methods that are not implemented and reports missing methods.
- Exports generated `.proto` files into a `.tar.gz` archive.

## Prerequisites

- Node.js (v14.x or later)
- Yarn package manager

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/protogen.git
cd protogen
```

2. Install the dependencies:
```bash
yarn install
```

## Usage

1. Run the script:
```bash
node generateProtos.js
```

2. Follow the prompts:
   - Enter the gRPC endpoint.
   - Select the connection type (plaintext or TLS).
   - Choose whether to generate a `.tar.gz` file for the `.proto` files.

## Example

```
? Enter the gRPC endpoint: sei.grpc.kjnodes.com:443
? Select connection type: TLS
? Do you want to generate a .tar.gz file for the .proto files? (Y/n) Y
```

## Output

- The generated `.proto` files will be saved in the `generated_protos` directory.
- If opted, a `.tar.gz` archive of the `generated_protos` directory will be created as `generated_protos.tar.gz`.

## Error Handling

The script will handle methods that are not implemented by the reflection service and will report them at the end of the execution.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue.

## License

This project is licensed under the MIT License.

