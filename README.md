# Cosmos SDK gRPC Proto Generator

This tool generates comprehensive proto files for Cosmos SDK-based chains using various reflection methods.

## Setup

1. Clone this repository:
   ```
   git clone https://github.com/your-username/cosmos-sdk-grpc-proto-generator.git
   cd cosmos-sdk-grpc-proto-generator
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `proto_includes` directory in the project root:
   ```
   mkdir proto_includes
   ```

4. Clone the following repositories into the `proto_includes` directory:

   a. Google APIs:
   ```
   git clone https://github.com/googleapis/googleapis.git proto_includes/googleapis
   ```

   b. Protocol Buffers:
   ```
   git clone https://github.com/protocolbuffers/protobuf.git proto_includes/protobuf
   ```

   c. Cosmos SDK:
   ```
   git clone https://github.com/cosmos/cosmos-sdk.git proto_includes/cosmos-sdk
   ```

   d. Gogo Protobuf:
   ```
   git clone https://github.com/gogo/protobuf.git proto_includes/gogo-protobuf
   ```

5. Ensure you have the `reflection.proto` file in the root directory of the project. This file combines standard gRPC reflection, Cosmos SDK custom reflection, and extended Cosmos SDK reflection (v2alpha1) methods.

## Usage

Run the script:
```
node generateProtos.js
```

Follow the prompts to enter the gRPC endpoint and other options.

## Output

The script will generate proto files in the `generated_protos` directory. If selected, it will also create a tarball of these files.

## Note

The `proto_includes` directory is included in the `.gitignore` file due to its size and to reduce unnecessary redundant code storage. If you're cloning this repository, make sure to follow the setup instructions to populate the `proto_includes` directory.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT License](LICENSE)
