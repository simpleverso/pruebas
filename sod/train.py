import os
import argparse
import math
from typing import NoReturn

import torch
from torch.utils.data.dataloader import DataLoader
from torch.utils.data import Subset
from torch.optim import SGD, lr_scheduler
from torch.hub import load_state_dict_from_url

from dataset import (
    get_coco_dataset,
    get_number_of_classes,
    get_model_categories_metadata,
)
from model import get_fasterrcnn_resnet50_fpn
from engine import train_one_epoch, evaluate
from utils import collate_fn

# ### Global Variables ###
# ## Model ##
TRAINABLE_BACKBONE_LAYERS = 3
# ## Data Fetching ##
BATCH_SIZE = 2
NUM_WORKERS = 2
# ## Optimization ##
LEARNING_RATE = 0.005 * BATCH_SIZE / 4  # Apply linear scaling rule
MOMENTUM = 0.9
WEIGHT_DECAY = 0.0005
STEP_SIZE = 3
GAMMA = 0.1
# ## Training ##
NUM_EPOCHS = 10
RATIO_TRAINING_SPLIT = 0.8
# ## Logging ##
PRINT_FREQUENCY = 10


def train(dataset_path: str) -> NoReturn:
    """Train an object detection model on the given dataset. The
    script will store a snapshot of the model after each epoch,
    containing the model's weights and the mapping between the
    model's output and the categories. Those snapshots can directly
    serve as input to the "detect.py" script.

    Args:
        dataset_path (str): path to the coco training dataset directory.

    Returns:
        NoReturn: [description]
    """
    model_output_path = os.path.join(
        "outputs", "models", os.path.basename(dataset_path)
    )
    os.makedirs(model_output_path, exist_ok=True)
    device = torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")
    print("Running training on device {}".format(device))
    train_dataset = get_coco_dataset(dataset_path, train=True)
    validation_dataset = get_coco_dataset(dataset_path, train=False)
    indices = torch.randperm(len(train_dataset)).tolist()
    train_samples = math.ceil(RATIO_TRAINING_SPLIT * len(train_dataset))
    train_dataset = Subset(train_dataset, indices[:train_samples])
    validation_dataset = Subset(validation_dataset, indices[train_samples:])
    training_dataloader = DataLoader(
        train_dataset,
        batch_size=BATCH_SIZE,
        num_workers=NUM_WORKERS,
        shuffle=True,
        collate_fn=collate_fn,
    )
    validation_dataloader = DataLoader(
        validation_dataset,
        batch_size=BATCH_SIZE,
        num_workers=NUM_WORKERS,
        shuffle=False,
        collate_fn=collate_fn,
    )
    model = get_fasterrcnn_resnet50_fpn(
        trainable_backbone_layers=TRAINABLE_BACKBONE_LAYERS,
        number_classes=get_number_of_classes(train_dataset.dataset),
    )
    model.to(device)
    # construct an optimizer
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = SGD(
        params, lr=LEARNING_RATE, momentum=MOMENTUM, weight_decay=WEIGHT_DECAY
    )
    # and a learning rate scheduler
    lr_scheduler_training = lr_scheduler.StepLR(
        optimizer, step_size=STEP_SIZE, gamma=GAMMA
    )

    for epoch in range(NUM_EPOCHS):
        train_one_epoch(
            model,
            optimizer,
            training_dataloader,
            device,
            epoch,
            print_freq=PRINT_FREQUENCY,
        )
        torch.save(
            {
                "state_dict": model.state_dict(),
                "categories": get_model_categories_metadata(train_dataset.dataset),
            },
            os.path.join(model_output_path, f"epoch_{epoch}.pth"),
        )
        lr_scheduler_training.step()
        # evaluate on the test dataset
        evaluate(model, validation_dataloader, device=device)


def main():
    parser = argparse.ArgumentParser(description="Train a model on a coco dataset.")
    parser.add_argument(
        "--dataset-path",
        dest="dataset_path",
        help="path to your coco dataset directory",
        required=True,
    )
    args = parser.parse_args()
    train(args.dataset_path)


if __name__ == "__main__":
    main()
